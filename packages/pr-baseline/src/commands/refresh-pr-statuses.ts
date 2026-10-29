import { createWriteBudget } from '../budget.ts';
import { ConfigError, DEFAULT_SCOPE, repoUrl } from '../config.ts';
import { baselinesOffBase, evaluateCommit } from '../evaluate.ts';
import { GitError } from '../git/repo.ts';
import { isGitHubError, RETRY_HINT } from '../github/errors.ts';
import { getPull, listOpenPulls, targetBase, type OpenPull } from '../github/pulls.ts';
import type { Runtime } from '../runtime.ts';
import type {
	Reporter,
	ResolvedBaseline,
	RefreshEntry,
	RefreshPrStatusesResult,
	RefreshScope,
	RefreshStopReason,
	Verdict,
} from '../types.ts';
import { createProgressThrottle, refSnapshot } from '../util.ts';
import { writeWithRetries } from '../reporter/write.ts';
import { compareStatus, misconfiguredVerdict, type VerdictContext } from '../verdict.ts';

/** What a scope does to the PRs it selects, and what it calls the ones it has not reached yet. */
const VERB: Record<RefreshScope, string> = {
	corrections: 'check',
	unstamped: 'stamp',
	all: 'visit',
};

/** Plain wording for what stopped a run, for the closing line. */
const STOP_PHRASE: Record<RefreshStopReason, string> = {
	'write-cap': 'the write cap',
	'primary-budget': 'the primary budget',
	'rate-limit': 'a rate limit',
	deferred: 'a PR whose head was still moving',
	failed: 'a failure that repeats for every PR',
};

/** What the population left in each scope is called, so a progress line reads naturally. */
const REMAINING_NOUN: Record<RefreshScope, string> = {
	corrections: 'still to check',
	unstamped: 'still unstamped',
	all: 'still to visit',
};

/** Stops the next run continues from on its own; anything else needs someone to look. */
const PAUSED_REASONS = new Set<RefreshStopReason>(['write-cap', 'primary-budget', 'rate-limit']);

export interface RefreshPrStatusesInput {
	/** Baselines already resolved by the caller, as after a move or in a dry run. */
	baselines?: ResolvedBaseline[];
	/** What the refs really are right now, when `baselines` is hypothetical (a dry-run move). */
	verifyRefs?: Array<{ name: string; sha: string | null }>;
	/** Overrides the configured scope; a move that can turn a red PR green passes `all`. */
	scope?: RefreshScope;
}

interface Setup {
	base: string;
	creator: string;
	reporter: Reporter;
	baselines: ResolvedBaseline[];
	baseHead: string;
	pulls: OpenPull[];
	/** Head OIDs as the adapter fetched them, when it could tell. */
	heads: Map<number, string | null> | undefined;
}

/** Brings the scoped open PRs' statuses in line with the current baselines, writing only what differs. */
export async function runRefreshPrStatuses(
	runtime: Runtime,
	input: RefreshPrStatusesInput = {},
): Promise<RefreshPrStatusesResult> {
	const { config, api, logger } = runtime;
	if (config.offline) {
		throw new ConfigError(
			'refresh-pr-statuses needs the API; --offline applies to refresh-pr-status only.',
		);
	}
	assertScopeUsable(runtime);
	let scope: RefreshScope = input.scope ?? config.scope;
	if (runtime.customReporter) {
		/* Bucketing reads the listing's commit statuses, which a custom reporter does not own,
		 * so the only honest population is every PR. */
		if (!config.scopeExplicit && input.scope === undefined) {
			logger.warn(
				'A custom reporter owns the statuses, which the PR listing cannot report; refreshing every open PR.',
			);
		}
		scope = 'all';
	}
	const ancestry = await runtime.ancestry();
	const budget = createWriteBudget({
		maxWritesPerRun: config.maxWritesPerRun,
		maxWritesPerMinute: config.maxWritesPerMinute,
		now: runtime.now,
	});
	const entries: RefreshEntry[] = [];
	const counts = {
		written: 0,
		skipped: 0,
		cosmetic: 0,
		closed: 0,
		deferred: 0,
		outOfScope: 0,
		failed: 0,
	};
	let reason: RefreshStopReason | undefined;
	/** Baselines that left the base branch; every PR then gets the misconfiguration pass. */
	let offBase: string[] = [];
	const finish = (
		base: string,
		baselines: ResolvedBaseline[],
		openPulls: number,
		selected: number,
	): RefreshPrStatusesResult => {
		const incomplete = reason !== undefined || counts.deferred > 0 || counts.failed > 0;
		if (incomplete && reason === undefined) {
			reason = counts.deferred > 0 ? 'deferred' : 'failed';
		}
		/* A pause is a run that made progress and hit a budget, with nothing left behind: a deferred
		 * PR's next head is unstamped, which no later `corrections` run revisits, so it is not a pause. */
		const paused =
			incomplete &&
			counts.failed === 0 &&
			counts.deferred === 0 &&
			counts.written > 0 &&
			reason !== undefined &&
			PAUSED_REASONS.has(reason);
		const accounted =
			counts.written +
			counts.skipped +
			counts.cosmetic +
			counts.closed +
			counts.deferred +
			counts.outOfScope +
			counts.failed;
		const remaining = Math.max(0, selected - accounted);
		const summary = `${counts.written} written, ${counts.skipped} skipped, ${counts.cosmetic} cosmetic, ${counts.failed} failed, ${remaining} remaining`;
		if (paused) {
			const runs = Math.ceil(remaining / config.maxWritesPerRun);
			/* Only a run at the same scope continues this one. A scope the run chose for itself is chosen
			 * again next time; one a caller or a move asked for is not, so that case says what it needs. */
			const promotedAgain = runtime.customReporter || offBase.length > 0;
			const more = `About ${runs} more ${runs === 1 ? 'run' : 'runs'} at this cap`;
			const next =
				scope === DEFAULT_SCOPE || promotedAgain
					? `${more}; the schedule continues automatically.`
					: `${more}, at scope ${scope}; a run at the default scope will not continue it.`;
			logger.warn(`Paused on ${STOP_PHRASE[reason as RefreshStopReason]}: ${summary}.\n${next}`);
		} else if (
			incomplete &&
			counts.written === 0 &&
			reason !== undefined &&
			PAUSED_REASONS.has(reason)
		) {
			/* A run that could not write at all is not waiting for a budget, it is being stopped by
			 * something: either this run spending its cap on abandoned attempts, or another workflow. */
			const cause =
				reason === 'write-cap'
					? 'the cap went on attempts that were abandoned'
					: "another workflow is consuming the repository's request budget";
			logger.warn(
				`Stopped on ${STOP_PHRASE[reason]} having written nothing: ${summary}. ${cause}. ${RETRY_HINT}`,
			);
		} else if (incomplete) {
			logger.warn(`Refresh incomplete (${reason}): ${summary}. ${RETRY_HINT}`);
		} else {
			logger.info(`Refresh complete: ${summary}.`);
		}
		return {
			base,
			baselines,
			openPulls,
			scope,
			selected,
			excluded: openPulls - selected,
			remaining,
			misconfigured: offBase,
			...counts,
			incomplete,
			paused,
			...(reason === undefined ? {} : { reason }),
			entries,
			ancestry: ancestry.name,
			dryRun: config.dryRun,
		};
	};

	let setup: Setup;
	let knownOpenPulls = 0;
	let knownSelected = 0;
	let buckets = { passing: 0, failing: 0, other: 0, unstamped: 0 };
	let resolvedBase: string | undefined;
	let resolvedBaselines: ResolvedBaseline[] | undefined = input.baselines;
	try {
		const base = await runtime.base();
		resolvedBase = base;
		// Resolved before any evaluation so a creator problem is a configuration error, not a partial refresh.
		const creator = await runtime.creator();
		const reporter = await runtime.reporter();
		const baselines = input.baselines ?? (await runtime.readBaselines());
		resolvedBaselines = baselines;
		const baseHead = await runtime.head();
		const refs = input.verifyRefs ?? refSnapshot(baselines);
		const list = async (): Promise<OpenPull[]> =>
			(await listOpenPulls(api, config.repo, { base, context: config.context })).filter(
				(pull) => targetBase(pull) === base && (config.includeDrafts || !pull.isDraft),
			);
		let inScope = await list();
		knownOpenPulls = inScope.length;
		/* Counted from the listing alone, before anything that can fail, so a run that stops early
		 * still reports what it would have covered rather than claiming the scope excluded everything. */
		knownSelected = inScope.filter((pull) => selects(pull, scope)).length;
		/* Preparation runs twice: the scope cannot be settled before the baselines are checked
		 * against the base head, and no PR head is worth fetching until it is. */
		await ancestry.prepare?.({ shas: [baseHead], pulls: [], refs });
		// Preparation verified the baseline refs and fetched the commits; only now is any ancestry asked.
		offBase = await baselinesOffBase(ancestry, baselines, baseHead);
		if (offBase.length > 0) {
			/* Refusing here would leave every PR on a stale status and a scheduled sweep permanently red.
			 * The single-PR path already posts a pass in this state, so the sweep matches it. */
			logger.warn(
				`Baseline ${offBase.join(', ')} is not on ${base}; posting passes instead of blocking. Repair it with a forced move to a commit on ${base}.`,
			);
			// The misconfiguration pass goes to every PR, so a scope that keeps only passing ones would write nothing.
			scope = 'all';
		}
		buckets = tally(inScope);
		inScope = inScope.filter((pull) => selects(pull, scope));
		knownSelected = inScope.length;
		/* Three lines before any work: where the baselines are, how the open PRs stand, and how much
		 * of that this run will touch. Emitted before the head fetch, which is what the silence was. */
		logger.info(`Base ${base} at ${baseHead.slice(0, 12)}; ${describe(baselines)}.`);
		logger.info(
			`${knownOpenPulls} open PRs: ${buckets.passing} passing, ${buckets.failing} failing, ${buckets.other} other, ${buckets.unstamped} unstamped.`,
		);
		logger.info(
			`Scope ${scope}: ${knownSelected} ${knownSelected === 1 ? 'PR' : 'PRs'} to ${VERB[scope]}, at most ${Math.min(knownSelected, config.maxWritesPerRun)} writes.`,
		);
		// A git adapter fetches the selected heads in a few batches here and reports which refs are gone.
		const prepared = await ancestry.prepare?.({
			shas: [],
			pulls: inScope.map((pull) => pull.number),
			refs,
		});
		if (prepared !== undefined) {
			/*
			 * A PR that closed during the fetch keeps its pull ref, so the fetch cannot tell.
			 * A second listing can: PRs that left it are closed, and the rest carry their latest head and status.
			 */
			const stillOpen = new Map((await list()).map((pull) => [pull.number, pull]));
			for (const pull of inScope) {
				if (!stillOpen.has(pull.number)) {
					// Gone from the listing: closed, retargeted, turned draft, or a listing race; REST says which.
					const reconciled = await reconcile(runtime, pull, null, base);
					const outcome = reconciled === null || reconciled === 'lagging' ? 'deferred' : reconciled;
					counts[outcome]++;
					entries.push(entry(pull, outcome));
				}
			}
			inScope = inScope.flatMap((pull) => stillOpen.get(pull.number) ?? []);
		}
		setup = {
			base,
			creator,
			reporter,
			baselines,
			baseHead,
			pulls: inScope,
			heads: prepared?.heads,
		};
	} catch (error) {
		// A limit hit while reading still owes the operator the retry guidance.
		if (isGitHubError(error, 'rate-limit')) {
			logger.warn(error.message);
			reason = 'rate-limit';
			return finish(
				resolvedBase ?? config.base ?? '',
				resolvedBaselines ?? [],
				knownOpenPulls,
				knownSelected,
			);
		}
		throw error;
	}
	const { base, creator, reporter, baselines, baseHead, heads } = setup;
	const context: VerdictContext = {
		base,
		descriptions: config.descriptions,
		targetUrl: config.targetUrl,
		repoUrl: repoUrl(config),
	};
	/* One verdict serves every PR: the baseline is unsatisfiable, so no head is worth an ancestry question. */
	const misconfigured = offBase.length > 0 ? misconfiguredVerdict(offBase, context) : undefined;
	const inScope = setup.pulls;
	const progress = createProgressThrottle(runtime.now());

	// Statuses belong to commits, so a head shared by several PRs is processed once, failures included.
	const settled = new Map<string, { verdict?: Verdict; error?: unknown; cosmetic?: boolean }>();
	/*
	 * Text-only differences wait for the material ones, which are the only writes that can unblock a merge.
	 * Keyed by head so a shared head is written once, and accounted only once the write has happened.
	 */
	const cosmetic = new Map<string, { verdict: Verdict; pulls: OpenPull[] }>();
	/** Writes one status through the budget; false when the run must stop. */
	const write = async (pull: OpenPull, verdict: Verdict): Promise<boolean> => {
		try {
			const outcome = await writeWithRetries(reporter, pull.headSha, verdict.status, {
				// Every physical attempt is budgeted and paced; the transport itself does not retry writes.
				async before() {
					const decision = budget.next(api.rest.remaining);
					if (!decision.ok) {
						reason = decision.reason;
						return false;
					}
					if (decision.waitMs > 0 && !config.dryRun) {
						await runtime.sleep(decision.waitMs);
					}
					budget.record();
					return true;
				},
				sleep: runtime.sleep,
				retryBaseMs: config.retryBaseMs,
			});
			if (outcome === 'abandoned') {
				return false;
			}
			settled.set(pull.headSha, { verdict });
			counts.written++;
			entries.push(entry(pull, 'written', verdict));
			if (progress.due(counts.written, runtime.now())) {
				const left =
					knownSelected -
					(counts.written +
						counts.skipped +
						counts.cosmetic +
						counts.closed +
						counts.deferred +
						counts.outOfScope +
						counts.failed);
				logger.info(
					`Written ${counts.written} of at most ${Math.min(knownSelected, config.maxWritesPerRun)}; ${Math.max(0, left)} PRs ${REMAINING_NOUN[scope]}.`,
				);
			}
			return true;
		} catch (error) {
			// A creator mismatch is an identity problem that repeats for every PR; the run fails outright.
			if (error instanceof ConfigError || error instanceof GitError) {
				throw error;
			}
			counts.failed++;
			entries.push(entry(pull, 'failed', verdict, error));
			settled.set(pull.headSha, { verdict, error });
			logger.warn(`PR #${pull.number}: ${message(error)}`);
			if (isGitHubError(error, 'rate-limit')) {
				reason = 'rate-limit';
				return false;
			}
			// A permission or auth failure repeats for every PR; stop instead of burning the budget.
			if (isGitHubError(error, 'permission') || isGitHubError(error, 'auth')) {
				reason = 'failed';
				return false;
			}
			return true;
		}
	};
	/**
	 * Settles a PR whose two API reads agree on a head its pull ref does not show.
	 * Returns `evaluate` unless the head is gone from the remote or the ref is ahead of it.
	 */
	const lagging = async (
		listed: OpenPull,
		fetched: string | null,
	): Promise<'evaluate' | 'deferred' | 'stopped'> => {
		const prepared = await ancestry.prepare?.({
			shas: [listed.headSha],
			pulls: [],
			refs: [],
			optional: [listed.headSha],
		});
		if (prepared?.missing?.includes(listed.headSha)) {
			logger.warn(
				`PR #${listed.number} is at a head the remote does not serve; deferred to the next run.`,
			);
			return 'deferred';
		}
		const probe = budget.next(api.rest.remaining);
		if (!probe.ok) {
			reason = probe.reason;
			return 'stopped';
		}
		// A ref ahead of both API reads means they are the stale ones, and its newer head would go unstamped.
		if (fetched !== null && (await ancestry.isAncestor(listed.headSha, fetched))) {
			logger.warn(`PR #${listed.number} is still moving; deferred to the next run.`);
			return 'deferred';
		}
		return 'evaluate';
	};
	for (const listed of inScope) {
		/*
		 * The listing and the fetch can disagree when a PR moved or closed in between.
		 * The fetched head is what can be evaluated; the PR is re-read once to learn what happened.
		 */
		let pull = listed;
		let reconciled = false;
		const fetched = heads?.get(listed.number);
		if (fetched !== undefined && fetched !== listed.headSha) {
			let settledAs: Reconciled | 'evaluate' | 'stopped';
			try {
				settledAs = await reconcile(runtime, listed, fetched, base, listed.headSha);
				if (settledAs === 'lagging') {
					settledAs = await lagging(listed, fetched);
				}
			} catch (error) {
				if (isGitHubError(error, 'rate-limit')) {
					reason = 'rate-limit';
					break;
				}
				throw error;
			}
			if (settledAs === 'stopped') {
				break;
			}
			if (settledAs === 'evaluate') {
				logger.info(
					`PR #${listed.number}: refs/pull/${listed.number}/head lags the API head; evaluating ${listed.headSha.slice(0, 12)}.`,
				);
			} else if (settledAs !== null) {
				counts[settledAs]++;
				entries.push(entry(listed, settledAs));
				continue;
			} else {
				pull = { ...listed, headSha: fetched as string, status: null };
				reconciled = true;
			}
		}
		const waiting = cosmetic.get(pull.headSha);
		if (waiting !== undefined) {
			// Accounted when the queue drains, so a write that never happens leaves it in `remaining`.
			waiting.pulls.push(pull);
			continue;
		}
		const shared = settled.get(pull.headSha);
		if (shared !== undefined) {
			if (shared.error === undefined) {
				// `skipped` means already current, so a head left alone as cosmetic keeps that name here.
				const outcome = shared.cosmetic === true ? 'cosmetic' : 'skipped';
				counts[outcome]++;
				entries.push(entry(pull, outcome, shared.verdict));
			} else {
				counts.failed++;
				entries.push(entry(pull, 'failed', shared.verdict, shared.error));
			}
			continue;
		}
		/* Probed first so an unwritable PR costs no ancestry request. */
		const probe = budget.next(api.rest.remaining);
		if (!probe.ok) {
			reason = probe.reason;
			break;
		}
		let verdict: Verdict;
		let current;
		try {
			verdict =
				misconfigured ??
				(await evaluateCommit({
					ancestry,
					baselines,
					sha: pull.headSha,
					baseHead,
					context,
					logger,
				}));
			// The listing already carries the commit status the built-in reporter would read; a custom reporter is asked.
			current =
				runtime.customReporter || reconciled ? await reporter.current(pull.headSha) : pull.status;
		} catch (error) {
			if (isGitHubError(error, 'rate-limit')) {
				reason = 'rate-limit';
				break;
			}
			// A git failure after preparation is the clone's problem, not this PR's; the run ends.
			if (error instanceof GitError) {
				throw error;
			}
			counts.failed++;
			entries.push(entry(pull, 'failed', undefined, error));
			settled.set(pull.headSha, { error });
			continue;
		}
		const difference = compareStatus(current, verdict.status, creator);
		if (difference === 'current') {
			settled.set(pull.headSha, { verdict });
			counts.skipped++;
			entries.push(entry(pull, 'skipped', verdict));
			continue;
		}
		if (difference === 'cosmetic') {
			if (scope === 'all') {
				cosmetic.set(pull.headSha, { verdict, pulls: [pull] });
			} else {
				// Description and link drift gate nothing, and a write from a 500 an hour budget is too expensive for it.
				settled.set(pull.headSha, { verdict, cosmetic: true });
				counts.cosmetic++;
				entries.push(entry(pull, 'cosmetic', verdict));
			}
			continue;
		}
		if (!(await write(pull, verdict))) {
			break;
		}
	}
	// A run that stopped stays stopped: draining here would spend a write past a budget or a permission failure.
	if (reason === undefined) {
		for (const queued of cosmetic.values()) {
			const [first, ...rest] = queued.pulls;
			if (first === undefined) {
				continue;
			}
			const keepGoing = await write(first, queued.verdict);
			/* The siblings take the head's outcome, as they do in the main loop; a head the budget
			 * abandoned is settled by nobody, so they stay unaccounted and land in `remaining`. */
			const outcome = settled.get(first.headSha);
			if (outcome !== undefined) {
				for (const sibling of rest) {
					if (outcome.error === undefined) {
						counts.skipped++;
						entries.push(entry(sibling, 'skipped', queued.verdict));
					} else {
						counts.failed++;
						entries.push(entry(sibling, 'failed', queued.verdict, outcome.error));
					}
				}
			}
			if (!keepGoing) {
				break;
			}
		}
	}
	return finish(base, baselines, knownOpenPulls, knownSelected);
}

/** How the open PRs stand on the context, for the plan line; the same four buckets `report` prints. */
function tally(pulls: OpenPull[]): {
	passing: number;
	failing: number;
	other: number;
	unstamped: number;
} {
	const counts = { passing: 0, failing: 0, other: 0, unstamped: 0 };
	for (const pull of pulls) {
		if (pull.status === null) {
			counts.unstamped++;
		} else if (pull.status.state === 'success') {
			counts.passing++;
		} else if (pull.status.state === 'failure') {
			counts.failing++;
		} else {
			counts.other++;
		}
	}
	return counts;
}

/**
 * Refuses a scope a custom reporter cannot honour, since the PR listing's statuses are not its.
 * `move-baseline` calls this before it moves anything, so a refusal is never a half-run.
 */
export function assertScopeUsable(runtime: Runtime): void {
	const { config } = runtime;
	if (runtime.customReporter && config.scopeExplicit && config.scope !== 'all') {
		throw new ConfigError(
			`A custom reporter owns the statuses a refresh compares against, so scope "${config.scope}" cannot be applied; use "all".`,
		);
	}
}

/** Whether a scope selects a PR, read from the status the listing carries. */
function selects(pull: OpenPull, scope: RefreshScope): boolean {
	if (scope === 'all') {
		return true;
	}
	/* Only a green PR can be turned red by a forward move; an `error` or `pending` status is in
	 * neither named bucket, and blocks a merge exactly as a failure does until `all` visits it. */
	return scope === 'corrections' ? pull.status?.state === 'success' : pull.status === null;
}

type Reconciled = 'closed' | 'deferred' | 'outOfScope' | 'lagging' | null;

/**
 * Decides a PR the listing and the fetch disagree about, through one REST read.
 * Returns why it cannot be evaluated, or null when the fetched head is its stable open in-scope head.
 * With `agreed`, the second listing's head, it returns `lagging` when REST agrees with it and only the pull ref differs.
 */
async function reconcile(
	runtime: Runtime,
	listed: OpenPull,
	fetched: string | null,
	base: string,
	agreed?: string,
): Promise<Reconciled> {
	const current = await getPull(runtime.api, runtime.config.repo, listed.number);
	if (current === null || current.state !== 'open') {
		return 'closed';
	}
	if (targetBase(current) !== base || (!runtime.config.includeDrafts && current.draft)) {
		runtime.logger.info(`PR #${listed.number} left the refresh's scope while it was preparing.`);
		return 'outOfScope';
	}
	if (fetched !== null && current.headSha === fetched) {
		return null;
	}
	if (agreed !== undefined && current.headSha === agreed) {
		return 'lagging';
	}
	if (fetched === null) {
		// The pull ref is gone but the PR is open: an in-flight change; the next run sees it settled.
		runtime.logger.warn(
			`PR #${listed.number} has no pull ref right now; deferred to the next run.`,
		);
		return 'deferred';
	}
	runtime.logger.warn(`PR #${listed.number} is still moving; deferred to the next run.`);
	return 'deferred';
}

function entry(
	pull: OpenPull,
	outcome: RefreshEntry['outcome'] | 'outOfScope',
	verdict?: RefreshEntry['verdict'],
	error?: unknown,
): RefreshEntry {
	return {
		number: pull.number,
		sha: pull.headSha,
		outcome: outcome === 'outOfScope' ? 'out-of-scope' : outcome,
		...(verdict === undefined ? {} : { verdict }),
		...(error === undefined ? {} : { error: message(error) }),
	};
}

function describe(baselines: ResolvedBaseline[]): string {
	return baselines
		.map(
			(baseline) =>
				`${baseline.name}=${baseline.sha === null ? 'absent' : baseline.sha.slice(0, 12)}`,
		)
		.join(', ');
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
