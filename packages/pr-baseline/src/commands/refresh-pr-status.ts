import { ConfigError, repoUrl } from '../config.ts';
import { baselinesOffBase, evaluateCommit } from '../evaluate.ts';
import { tryRevParse } from '../git/local.ts';
import { revParse } from '../git/repo.ts';
import { getPull, targetBase } from '../github/pulls.ts';
import { resolveCommit } from '../github/refs.ts';
import type { Runtime } from '../runtime.ts';
import type {
	Ancestry,
	RefreshPrStatusOptions,
	RefreshPrStatusResult,
	ResolvedBaseline,
	Verdict,
} from '../types.ts';
import { writeWithRetries } from '../reporter/write.ts';
import { isFullSha, refSnapshot } from '../util.ts';
import {
	misconfiguredVerdict,
	notApplicableVerdict,
	compareStatus,
	type VerdictContext,
} from '../verdict.ts';

/** Snapshot reads before posting; the refs almost never move twice within one status update. */
const SNAPSHOT_ROUNDS = 3;

interface Target {
	sha: string;
	/** The branch the PR lands on when a PR was given. */
	baseRef: string | undefined;
	/** Whether reporting defaults on: only a PR is known to come from an event; any bare commit is a local question. */
	fromEvent: boolean;
}

/** Evaluates one commit and, when reporting, brings its status up to date. */
export async function runRefreshPrStatus(
	runtime: Runtime,
	options: RefreshPrStatusOptions,
): Promise<RefreshPrStatusResult> {
	const { config, logger } = runtime;
	if (options.pr !== undefined && options.sha !== undefined) {
		throw new ConfigError('refresh-pr-status accepts either a commit or --pr, not both.');
	}
	if (config.offline && (options.pr !== undefined || options.report)) {
		throw new ConfigError('--offline is local only: it cannot resolve --pr or write a status.');
	}
	const base = await runtime.base();
	const ancestry = await runtime.ancestry();
	const target = await resolveTarget(runtime, options);
	const report = options.report ?? target.fromEvent;
	const context: VerdictContext = {
		base,
		descriptions: config.descriptions,
		targetUrl: config.targetUrl,
		repoUrl: repoUrl(config),
	};
	const result = (verdict: Verdict, baselines: ResolvedBaseline[]): RefreshPrStatusResult => ({
		sha: target.sha,
		base,
		verdict,
		baselines,
		written: false,
		skipped: false,
		outOfScope: false,
		ancestry: ancestry.name,
	});

	let baselines = await runtime.readBaselines();
	if (target.baseRef !== undefined && target.baseRef !== base) {
		const verdict = notApplicableVerdict(context);
		if (config.otherBases === 'skip' || !report) {
			logger.info(`PR targets ${target.baseRef}, not ${base}; no status written.`);
			return { ...result(verdict, baselines), outOfScope: true };
		}
		return {
			...(await write(runtime, target.sha, verdict, result(verdict, baselines))),
			outOfScope: true,
		};
	}
	if (report) {
		// Resolved before any evaluation so a creator problem is a configuration error, not a late surprise.
		await runtime.creator();
	}

	let baseHead = await runtime.head();
	const prepare = (list: ResolvedBaseline[], head: string) =>
		ancestry.prepare?.({
			shas: [head, target.sha],
			pulls: [],
			refs: config.offline ? [] : refSnapshot(list),
		});
	await prepare(baselines, baseHead);
	const evaluate = (list: ResolvedBaseline[], head: string) =>
		evaluateWithGuard({
			runtime,
			ancestry,
			baselines: list,
			sha: target.sha,
			baseHead: head,
			context,
		});
	let verdict = await evaluate(baselines, baseHead);
	if (!report) {
		return result(verdict, baselines);
	}

	/*
	 * Before posting, the baseline refs and then the base head are read again until two consecutive snapshots agree.
	 * A move that lands between a ref read and a head read would otherwise pair an old baseline with a new head.
	 */
	for (let round = 1; round <= SNAPSHOT_ROUNDS; round++) {
		const latest = await runtime.readBaselines();
		const latestHead = await runtime.head();
		const same =
			latestHead === baseHead &&
			latest.every((entry, index) => entry.sha === baselines[index]?.sha);
		if (same) {
			break;
		}
		baselines = latest;
		baseHead = latestHead;
		await prepare(baselines, baseHead);
		verdict = await evaluate(baselines, baseHead);
		if (round === SNAPSHOT_ROUNDS) {
			logger.warn(
				'The baselines kept moving during this status update; the next refresh converges the result.',
			);
		}
	}
	return write(runtime, target.sha, verdict, result(verdict, baselines));
}

/** A baseline that left the base branch yields a misconfiguration pass instead of any verdict. */
async function evaluateWithGuard(input: {
	runtime: Runtime;
	ancestry: Ancestry;
	baselines: ResolvedBaseline[];
	sha: string;
	baseHead: string;
	context: VerdictContext;
}): Promise<Verdict> {
	const { runtime, ancestry, baselines, sha, baseHead, context } = input;
	const off = await baselinesOffBase(ancestry, baselines, baseHead);
	if (off.length > 0) {
		runtime.logger.warn(
			`Baseline ${off.join(', ')} is not on ${context.base}; posting a pass instead of blocking.`,
		);
		return misconfiguredVerdict(off, context);
	}
	return evaluateCommit({
		ancestry,
		baselines,
		sha,
		baseHead,
		context,
		logger: runtime.logger,
	});
}

async function write(
	runtime: Runtime,
	sha: string,
	verdict: Verdict,
	result: RefreshPrStatusResult,
): Promise<RefreshPrStatusResult> {
	const creator = await runtime.creator();
	const reporter = await runtime.reporter();
	const current = await reporter.current(sha);
	if (compareStatus(current, verdict.status, creator) === 'current') {
		runtime.logger.info(`Status already current (${verdict.status.state}); nothing written.`);
		return { ...result, skipped: true };
	}
	await writeWithRetries(reporter, sha, verdict.status, {
		before: () => Promise.resolve(true),
		sleep: runtime.sleep,
		retryBaseMs: runtime.config.retryBaseMs,
	});
	return { ...result, written: true };
}

/** Resolves a ref in the clone through the adapter's runner when there is one, so offline settings apply. */
async function localRef(runtime: Runtime, ref: string): Promise<string | null> {
	const repo = await runtime.repo();
	return repo === null
		? tryRevParse(ref, runtime.config.gitDir, runtime.config.token)
		: revParse(repo, ref);
}

async function resolveTarget(runtime: Runtime, options: RefreshPrStatusOptions): Promise<Target> {
	const { api, config } = runtime;
	if (options.pr !== undefined) {
		const pull = await getPull(api, config.repo, options.pr);
		if (pull === null) {
			throw new ConfigError(`Pull request #${options.pr} was not found in ${config.repo}.`);
		}
		return { sha: pull.headSha, baseRef: targetBase(pull), fromEvent: true };
	}
	if (options.sha !== undefined) {
		if (isFullSha(options.sha)) {
			return { sha: options.sha.toLowerCase(), baseRef: options.baseRef, fromEvent: false };
		}
		const local = await localRef(runtime, options.sha);
		if (local === null && config.offline) {
			throw new ConfigError(`Offline: "${options.sha}" does not resolve in the clone.`);
		}
		const sha = local ?? (await resolveCommit(api, config.repo, options.sha));
		return { sha, baseRef: options.baseRef, fromEvent: false };
	}
	const head = await localRef(runtime, 'HEAD');
	if (head === null) {
		throw new ConfigError(
			'refresh-pr-status needs a commit: pass a SHA or ref, --pr, or run inside a git repository.',
		);
	}
	return { sha: head, baseRef: options.baseRef, fromEvent: false };
}
