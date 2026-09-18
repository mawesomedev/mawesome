import * as core from '@actions/core';
import {
	BaselineError,
	ConfigError,
	createClient,
	isGitHubError,
	parseBaselines,
	shorthandBaselines,
	type Baseline,
	type RefreshPrStatusResult,
	type Client,
	type ClientOptions,
	type MoveBaselineResult,
	type ReportResult,
	type RefreshPrStatusesResult,
} from '@mawesome/pr-baseline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Per-PR entries kept in the `summary` output; the rest goes to `results-file`. */
const SUMMARY_ENTRIES = 200;

/** UTF-16 code units allowed for the `summary` output: a quarter of GitHub's 1 MB cap, leaving room for the other outputs. */
const OUTPUT_BUDGET = 256 * 1024;

const OUTPUT_NAMES = [
	'state',
	'description',
	'base',
	'baselines',
	'missing',
	'scope',
	'selected',
	'excluded',
	'written',
	'skipped',
	'cosmetic',
	'closed',
	'deferred',
	'failed',
	'remaining',
	'incomplete',
	'paused',
	'moved',
	'moved-baselines',
	'summary',
	'results-file',
] as const;

type TokenKind = 'workflow' | 'custom';

type Mode = 'auto' | 'refresh-pr-status' | 'refresh-pr-statuses' | 'move-baseline' | 'report';

interface Event {
	name: string;
	payload: Record<string, unknown>;
	actor: string;
}

interface Plan {
	mode: Exclude<Mode, 'auto'>;
	sha?: string;
	baseRef?: string;
	report?: boolean;
	force?: boolean;
	refreshPrStatuses?: boolean;
	/** False for the events that fire on every base-branch push, so a push that moved nothing costs no refresh. */
	refreshWhenUnchanged?: boolean;
	/** Set when `auto` decided there is nothing to do; the reason goes to a notice. */
	skip?: string;
}

/** Runs the action against `process.env`, the way the runner does; exported for tests. */
export async function run(): Promise<void> {
	let base = '';
	try {
		const event = readEvent();
		const options = clientOptions();
		base = options.base ?? '';
		const plan = decide(mode(), event, options.base, tokenKind());
		if (plan.skip !== undefined) {
			core.notice(plan.skip);
			await finish({ state: 'skipped', description: plan.skip, base }, 'skipped', plan.skip);
			return;
		}
		const client = createClient(options);
		await execute(client, plan, options);
	} catch (error) {
		const message = describeError(error);
		await finish({ state: 'error', description: message, base }, 'error', message);
		core.setFailed(message);
	}
}

/** Sets every output, filling the ones a path has no value for, so consumers can rely on the whole schema. */
function emit(values: Record<string, string | number | boolean>): void {
	setCommonOutputs({
		...Object.fromEntries(OUTPUT_NAMES.map((name) => [name, ''])),
		baselines: '[]',
		missing: '[]',
		scope: '',
		selected: 0,
		excluded: 0,
		written: 0,
		skipped: 0,
		cosmetic: 0,
		closed: 0,
		deferred: 0,
		failed: 0,
		remaining: 0,
		incomplete: false,
		paused: false,
		moved: false,
		'moved-baselines': '[]',
		...values,
	});
}

/** A run that ends before a command produces a result still sets every output and writes a summary. */
async function finish(
	values: Record<string, string | number | boolean>,
	heading: string,
	text: string,
): Promise<void> {
	emit({ summary: JSON.stringify(values), ...values });
	core.summary.addHeading(`PR baseline: ${heading}`, 3).addRaw(`\n${text}\n`);
	await writeSummary();
}

/** The runner always provides a summary file; a direct caller may not, which is not worth failing over. */
async function writeSummary(): Promise<void> {
	try {
		await core.summary.write();
	} catch (error) {
		core.warning(
			`Step summary not written: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function tokenKind(): TokenKind {
	const token = core.getInput('token');
	return token.length > 0 && token === core.getInput('github-token-probe') ? 'workflow' : 'custom';
}

function mode(): Mode {
	const value = core.getInput('mode') || 'auto';
	if (
		!['auto', 'refresh-pr-status', 'refresh-pr-statuses', 'move-baseline', 'report'].includes(value)
	) {
		throw new ConfigError(
			`Unknown mode "${value}": expected auto, refresh-pr-status, refresh-pr-statuses, move-baseline or report.`,
		);
	}
	return value as Mode;
}

function readEvent(): Event {
	const name = process.env['GITHUB_EVENT_NAME'] ?? '';
	const path = process.env['GITHUB_EVENT_PATH'];
	let payload: Record<string, unknown> = {};
	if (path !== undefined && path.length > 0) {
		payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	}
	return { name, payload, actor: process.env['GITHUB_ACTOR'] ?? '' };
}

/** Maps the event to a command in `auto` mode; explicit modes take the inputs as they are. */
export function decide(
	selected: Mode,
	event: Event,
	base: string | undefined,
	token: TokenKind = 'workflow',
): Plan {
	// The workflow token is read-only in any run Dependabot triggers, whatever the event or mode.
	const restricted = token === 'workflow' && event.actor === 'dependabot[bot]';
	const plan = selected === 'auto' ? auto(event, base, token) : explicit(selected, event);
	return restricted ? restrict(plan) : plan;
}

/** Turns a plan into what a read-only token can still do: evaluate, or nothing. */
function restrict(plan: Plan): Plan {
	if (plan.skip !== undefined || plan.mode === 'report') {
		return plan;
	}
	if (plan.mode === 'refresh-pr-status') {
		if (plan.report !== false) {
			core.notice(
				'Dependabot triggered this run, so its token cannot write and the commit is evaluated only. Configure a custom token, stored as a Dependabot secret so this run can read it, or schedule a refresh-pr-statuses run with scope unstamped to stamp the commit later.',
			);
		}
		return { ...plan, report: false };
	}
	return {
		mode: 'refresh-pr-status',
		skip: 'Dependabot triggered this run, so its token cannot move a baseline or write statuses; the scheduled run makes the move, and a custom token or a scope unstamped backfill stamps the commit.',
	};
}

function auto(event: Event, base: string | undefined, token: TokenKind): Plan {
	const pull = event.payload['pull_request'] as
		| {
				head: { sha: string; repo: { full_name?: string } | null };
				base: { ref: string };
				merged?: boolean;
		  }
		| undefined;
	const repository = event.payload['repository'] as
		| { full_name?: string; default_branch?: string }
		| undefined;
	switch (event.name) {
		case 'pull_request_target': {
			if (pull === undefined) {
				throw new ConfigError('pull_request_target event without a pull_request payload.');
			}
			if (event.payload['action'] !== 'closed') {
				return {
					mode: 'refresh-pr-status',
					sha: pull.head.sha,
					baseRef: pull.base.ref,
					report: true,
				};
			}
			if (pull.merged !== true) {
				return {
					mode: 'refresh-pr-status',
					skip: 'Pull request closed without merging; nothing to do.',
				};
			}
			// A merge fires this and a push to the base branch; neither is worth a refresh that has nothing to correct.
			return {
				mode: 'move-baseline',
				force: false,
				refreshPrStatuses: true,
				refreshWhenUnchanged: false,
			};
		}
		case 'pull_request': {
			if (pull === undefined) {
				return {
					mode: 'refresh-pr-status',
					skip: 'pull_request event without a pull_request payload, which happens for some fork PRs; nothing to do.',
				};
			}
			const fork = isFork(pull.head.repo, repository);
			/* A fork's run is denied the repository's secrets, so a token set from one arrives empty.
			 * Failing for a missing token would put a red X on every fork PR, and nothing could be written anyway. */
			if (fork && core.getInput('token').length === 0) {
				return {
					mode: 'refresh-pr-status',
					skip: 'The token input is empty, which is what a fork pull_request run gets from a secret; nothing can be written. Report on fork PRs through pull_request_target, or through a refresh with scope: unstamped.',
				};
			}
			const report = canWriteOnPullRequest(fork, token);
			return { mode: 'refresh-pr-status', sha: pull.head.sha, baseRef: pull.base.ref, report };
		}
		case 'merge_group': {
			const group = event.payload['merge_group'] as
				| { head_sha: string; base_ref: string }
				| undefined;
			if (group === undefined) {
				throw new ConfigError('merge_group event without a merge_group payload.');
			}
			return {
				mode: 'refresh-pr-status',
				sha: group.head_sha,
				baseRef: group.base_ref.replace(/^refs\/heads\//, ''),
				report: true,
			};
		}
		case 'push': {
			const ref = String(event.payload['ref'] ?? '');
			const branch = base ?? repository?.default_branch;
			if (branch === undefined) {
				throw new ConfigError(
					'push event without repository.default_branch in the payload; pass base.',
				);
			}
			if (ref !== `refs/heads/${branch}`) {
				return {
					mode: 'refresh-pr-status',
					skip: `Push to ${ref}, not the base branch ${branch}; nothing to do.`,
				};
			}
			return {
				mode: 'move-baseline',
				force: false,
				refreshPrStatuses: true,
				refreshWhenUnchanged: false,
			};
		}
		case 'schedule':
		case 'workflow_dispatch':
			/* A dispatch that wants anything else passes an explicit mode; the workflow owns that choice.
			 * These two refresh whatever moved: they are the net under a lost, paused or skipped run. */
			return { mode: 'move-baseline', force: false, refreshPrStatuses: true };
		default:
			throw new ConfigError(
				`mode: auto has no mapping for the ${event.name || 'unknown'} event; pass an explicit mode.`,
			);
	}
}

/** The head repository differs from the one the run belongs to, or the payload dropped it altogether. */
function isFork(
	head: { full_name?: string } | null,
	repository: { full_name?: string } | undefined,
): boolean {
	return (
		head === null ||
		(head.full_name !== undefined &&
			repository?.full_name !== undefined &&
			head.full_name.toLowerCase() !== repository.full_name.toLowerCase())
	);
}

/** The workflow token is read-only on a fork PR; any other token is the consumer's choice and is assumed to write. */
function canWriteOnPullRequest(fork: boolean, token: TokenKind): boolean {
	if (token === 'custom') {
		return true;
	}
	if (fork) {
		core.notice(
			'A pull_request run from a fork cannot write statuses; outputs are set and nothing is written. Report on fork PRs through pull_request_target, which a public repository has to allow in an Actions event policy, or through a refresh with scope: unstamped.',
		);
	}
	return !fork;
}

/** A pinned mode still gets the event's refresh rule, so `mode: move-baseline` on a push behaves like `auto`. */
function explicit(selected: Exclude<Mode, 'auto'>, event: Event): Plan {
	switch (selected) {
		case 'refresh-pr-status': {
			const sha = core.getInput('sha');
			if (sha.length === 0) {
				throw new ConfigError('mode: refresh-pr-status needs the sha input.');
			}
			return { mode: 'refresh-pr-status', sha, report: true };
		}
		case 'move-baseline':
			return {
				mode: 'move-baseline',
				force: booleanInput('force', false),
				refreshPrStatuses: booleanInput('refresh-pr-statuses-after-move', true),
				refreshWhenUnchanged: refreshesWhenUnchanged(event),
			};
		default:
			return { mode: selected };
	}
}

/** The events that fire on every base-branch push get no refresh when nothing moved; everything else keeps one. */
function refreshesWhenUnchanged(event: Event): boolean {
	const pull = event.payload['pull_request'] as { merged?: boolean } | undefined;
	if (event.name === 'push') {
		return false;
	}
	return !(
		event.name === 'pull_request_target' &&
		event.payload['action'] === 'closed' &&
		pull?.merged === true
	);
}

async function execute(client: Client, plan: Plan, options: ClientOptions): Promise<void> {
	switch (plan.mode) {
		case 'refresh-pr-status': {
			const result = await client.refreshPrStatus({
				...(plan.sha === undefined ? {} : { sha: plan.sha }),
				...(plan.baseRef === undefined ? {} : { baseRef: plan.baseRef }),
				...(plan.report === undefined ? {} : { report: plan.report }),
			});
			await reportRefreshPrStatus(result);
			return;
		}
		case 'refresh-pr-statuses': {
			const result = await client.refreshPrStatuses();
			await reportRefreshPrStatuses(result);
			return;
		}
		case 'move-baseline': {
			const selector = core.getInput('baseline');
			const result = await client.moveBaseline({
				force: plan.force ?? false,
				refreshPrStatuses: plan.refreshPrStatuses ?? true,
				refreshWhenUnchanged: plan.refreshWhenUnchanged ?? true,
				...(selector.length === 0 ? {} : { baseline: selector }),
			});
			await reportMove(result, options.dryRun ?? false);
			return;
		}
		case 'report': {
			const result = await client.report();
			await reportReport(result);
			return;
		}
		default:
			return;
	}
}

function clientOptions(): ClientOptions {
	const token = core.getInput('token');
	const probe = core.getInput('github-token-probe');
	const options: ClientOptions = {
		tokenIsWorkflowToken: token.length > 0 && token === probe,
		dryRun: booleanInput('dry-run', false),
		logger: { info: (message) => core.info(message), warn: (message) => core.warning(message) },
	};
	if (token.length > 0) {
		options.token = token;
	}
	const baselines = baselineList();
	if (baselines !== undefined) {
		options.baselines = baselines;
	}
	assign(options, 'base', core.getInput('base'));
	assign(options, 'context', core.getInput('status-context'));
	assign(options, 'targetUrl', core.getInput('target-url'));
	assign(options, 'creator', core.getInput('creator'));
	assign(options, 'ancestry', core.getInput('ancestry') as ClientOptions['ancestry']);
	assign(options, 'otherBases', core.getInput('other-bases') as ClientOptions['otherBases']);
	assign(options, 'scope', core.getInput('scope') as ClientOptions['scope']);
	assign(
		options,
		'maxWritesPerRun',
		positiveInteger(core.getInput('max-writes-per-run'), 'max-writes-per-run'),
	);
	assign(
		options,
		'maxWritesPerMinute',
		positiveInteger(core.getInput('max-writes-per-minute'), 'max-writes-per-minute'),
	);
	const descriptions: NonNullable<ClientOptions['descriptions']> = {};
	assign(descriptions, 'pass', core.getInput('description-pass'));
	assign(descriptions, 'fail', core.getInput('description-fail'));
	assign(descriptions, 'notApplicable', core.getInput('description-not-applicable'));
	if (Object.keys(descriptions).length > 0) {
		options.descriptions = descriptions;
	}
	return options;
}

function baselineList(): Baseline[] | undefined {
	const json = core.getInput('baselines');
	const name = core.getInput('name');
	const label = core.getInput('label');
	const markers = core
		.getMultilineInput('markers')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const shorthand = name.length > 0 || label.length > 0 || markers.length > 0;
	if (json.length > 0) {
		if (shorthand) {
			throw new ConfigError('baselines cannot be combined with name, label or markers.');
		}
		if (json.startsWith('@')) {
			throw new ConfigError(
				'baselines takes the JSON array itself; the action does not read files.',
			);
		}
		return parseBaselines(json, () => {
			throw new ConfigError(
				'baselines takes the JSON array itself; the action does not read files.',
			);
		});
	}
	if (!shorthand) {
		return undefined;
	}
	return shorthandBaselines({
		...(name.length > 0 ? { name } : {}),
		...(label.length > 0 ? { label } : {}),
		...(markers.length > 0 ? { markers } : {}),
	});
}

function assign<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | '' | undefined,
): void {
	if (value !== undefined && value !== '') {
		target[key] = value;
	}
}

/** The runner fills defaults from action.yml; a direct caller may leave an input unset. */
function booleanInput(name: string, fallback: boolean): boolean {
	return core.getInput(name).length === 0 ? fallback : core.getBooleanInput(name);
}

/** Both caps are positive by contract; checking here names the input rather than the library option. */
function positiveInteger(value: string, name: string): number | undefined {
	if (value.length === 0) {
		return undefined;
	}
	const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new ConfigError(`${name} expects a positive integer, got "${value}".`);
	}
	return parsed;
}

function setCommonOutputs(values: Record<string, string | number | boolean>): void {
	for (const [name, value] of Object.entries(values)) {
		core.setOutput(name, String(value));
	}
}

function baselinesOutput(baselines: ReadonlyArray<{ name: string; sha: string | null }>): string {
	return JSON.stringify(baselines.map((baseline) => ({ name: baseline.name, sha: baseline.sha })));
}

async function reportRefreshPrStatus(result: RefreshPrStatusResult): Promise<void> {
	emit({
		state: result.verdict.status.state,
		description: result.verdict.status.description,
		base: result.base,
		baselines: baselinesOutput(result.baselines),
		missing: JSON.stringify(result.verdict.missing),
		written: result.written ? 1 : 0,
		skipped: result.skipped ? 1 : 0,
		closed: 0,
		deferred: 0,
		failed: 0,
		incomplete: false,
		summary: JSON.stringify({
			mode: 'refresh-pr-status',
			sha: result.sha,
			base: result.base,
			verdict: result.verdict,
			written: result.written,
			skipped: result.skipped,
			outOfScope: result.outOfScope,
			ancestry: result.ancestry,
		}),
	});
	core.summary
		.addHeading('PR baseline status', 3)
		.addTable([
			[
				{ data: 'Commit', header: true },
				{ data: 'Verdict', header: true },
				{ data: 'Status', header: true },
			],
			[
				result.sha.slice(0, 12),
				result.verdict.kind,
				result.written ? 'written' : result.skipped ? 'already current' : 'not written',
			],
		])
		.addRaw(`\n${result.verdict.status.description}\n`);
	if (result.verdict.missing.length > 0) {
		core.summary.addRaw(`\nMissing baselines: ${result.verdict.missing.join(', ')}\n`);
	}
	await writeSummary();
}

/**
 * JSON for the `summary` output of a refresh, dropping per-PR entries until it fits the budget; `results-file` keeps them all.
 * When even the counts do not fit, the counts alone are emitted with `truncated: true`.
 */
export function boundedSummary(
	result: RefreshPrStatusesResult,
	extra: Record<string, unknown> = {},
	budget: number = OUTPUT_BUDGET,
): string {
	let keep = Math.min(result.entries.length, SUMMARY_ENTRIES);
	for (;;) {
		const text = JSON.stringify({
			...extra,
			...result,
			entries: result.entries.slice(0, keep),
			entriesOmitted: result.entries.length - keep,
		});
		if (text.length <= budget) {
			return text;
		}
		if (keep === 0) {
			break;
		}
		keep = Math.floor(keep / 2);
	}
	const { entries, baselines, ...counts } = result;
	const moves = Array.isArray(extra['moves'])
		? (extra['moves'] as { name: string; moved: boolean }[]).map(({ name, moved }) => ({
				name,
				moved,
			}))
		: undefined;
	return JSON.stringify({
		...(moves === undefined ? {} : { moves }),
		...counts,
		baselines: baselines.length,
		entries: [],
		entriesOmitted: entries.length,
		truncated: true,
	});
}

async function reportRefreshPrStatuses(
	result: RefreshPrStatusesResult,
	extra: Record<string, unknown> = {},
	/* Passed explicitly rather than through `extra`, which never reaches `emit`, so a run that both
	 * moved and refreshed still reports what moved. */
	move: { moved: boolean; movedBaselines: string[] } = { moved: false, movedBaselines: [] },
): Promise<void> {
	const file = join(
		process.env['RUNNER_TEMP'] ?? process.cwd(),
		`pr-baseline-refresh-${Date.now()}.json`,
	);
	writeFileSync(file, JSON.stringify({ ...extra, ...result }, null, 2));
	/* A baseline off the base branch is an operator problem the refresh cannot fix, and the open gate must
	 * be seen: the step fails while the news is new, then warns once every PR carries the message. */
	const misconfigured =
		result.misconfigured.length === 0
			? undefined
			: `Baseline ${result.misconfigured.join(', ')} is not on ${result.base}; every PR passes until a forced move puts it back.`;
	// Nothing written means every in-scope PR already says so; with no PRs at all, only this run can.
	const unannounced = misconfigured !== undefined && (result.written > 0 || result.openPulls === 0);
	const offBase = `Baseline ${result.misconfigured.join(', ')} is not on ${result.base}`;
	emit({
		state: (result.incomplete && !result.paused) || unannounced ? 'failure' : 'success',
		/* The description names whatever failed the step, so a pause never hides a misconfiguration
		 * that is the reason the step is red. */
		description:
			result.incomplete && !result.paused
				? `Refresh incomplete (${result.reason})`
				: unannounced
					? offBase
					: result.paused
						? `Refresh paused (${result.reason}), ${result.remaining} remaining`
						: misconfigured === undefined
							? 'Refresh complete'
							: offBase,
		base: result.base,
		baselines: baselinesOutput(result.baselines),
		missing: '[]',
		scope: result.scope,
		selected: result.selected,
		excluded: result.excluded,
		written: result.written,
		skipped: result.skipped,
		cosmetic: result.cosmetic,
		closed: result.closed,
		deferred: result.deferred,
		failed: result.failed,
		remaining: result.remaining,
		incomplete: result.incomplete,
		paused: result.paused,
		moved: move.moved,
		'moved-baselines': JSON.stringify(move.movedBaselines),
		summary: boundedSummary(result, extra),
		'results-file': file,
	});
	core.summary.addHeading('PR baseline refresh', 3).addTable([
		[
			{ data: 'Open PRs', header: true },
			{ data: 'Selected', header: true },
			{ data: 'Written', header: true },
			{ data: 'Skipped', header: true },
			{ data: 'Cosmetic', header: true },
			{ data: 'Closed', header: true },
			{ data: 'Deferred', header: true },
			{ data: 'Out of scope', header: true },
			{ data: 'Failed', header: true },
			{ data: 'Remaining', header: true },
		],
		[
			String(result.openPulls),
			`${result.selected} (${result.scope})`,
			String(result.written),
			String(result.skipped),
			String(result.cosmetic),
			String(result.closed),
			String(result.deferred),
			String(result.outOfScope),
			String(result.failed),
			String(result.remaining),
		],
	]);
	if (result.paused) {
		core.summary.addRaw(
			`\nPaused: ${result.reason}. ${result.remaining} PRs left at scope ${result.scope}.\n`,
		);
	} else if (result.incomplete) {
		core.summary.addRaw(`\nIncomplete: ${result.reason}. Dispatch the workflow to continue.\n`);
	}
	if (misconfigured !== undefined) {
		core.summary.addRaw(`\n${misconfigured}\n`);
	}
	await writeSummary();
	if (misconfigured !== undefined) {
		if (unannounced) {
			core.setFailed(misconfigured);
		} else {
			core.warning(misconfigured);
		}
	}
	// The command already logged the closing line with the counts; only the failure needs to fail the step.
	if (result.incomplete && !result.paused) {
		core.setFailed(
			`Refresh incomplete (${result.reason}); ${result.remaining} PRs left. Retry by dispatching the workflow.`,
		);
	}
}

async function reportMove(result: MoveBaselineResult, dryRun: boolean): Promise<void> {
	const moved = result.moves.filter((move) => move.moved);
	core.summary.addHeading(`PR baseline move${dryRun ? ' (dry run)' : ''}`, 3).addTable([
		[
			{ data: 'Baseline', header: true },
			{ data: 'From', header: true },
			{ data: 'To', header: true },
			{ data: 'Moved', header: true },
			{ data: 'Reason', header: true },
		],
		...result.moves.map((move) => [
			move.name,
			move.from === null ? 'absent' : move.from.slice(0, 12),
			move.to.slice(0, 12),
			move.moved ? 'yes' : 'no',
			move.moved ? (move.reason ?? '') : (move.note ?? ''),
		]),
	]);
	await writeSummary();
	if (result.refresh !== undefined) {
		// The move details ride along with the refresh, so a consumer still sees what moved and why.
		await reportRefreshPrStatuses(
			result.refresh,
			{ moves: result.moves },
			{ moved: moved.length > 0, movedBaselines: moved.map((move) => move.name) },
		);
		return;
	}
	emit({
		state: 'success',
		description:
			moved.length === 0
				? 'No baseline moved'
				: `Moved ${moved.map((move) => move.name).join(', ')}`,
		base: result.base,
		baselines: baselinesOutput(result.baselines),
		missing: '[]',
		written: 0,
		skipped: 0,
		closed: 0,
		deferred: 0,
		failed: 0,
		incomplete: false,
		moved: moved.length > 0,
		'moved-baselines': JSON.stringify(moved.map((move) => move.name)),
		summary: JSON.stringify(result),
	});
}

async function reportReport(result: ReportResult): Promise<void> {
	emit({
		state: result.offBase.length === 0 ? 'success' : 'failure',
		description:
			result.offBase.length === 0
				? `${result.openPulls} open PRs`
				: `Baseline ${result.offBase.join(', ')} is not on ${result.base}`,
		base: result.base,
		baselines: baselinesOutput(result.baselines),
		missing: '[]',
		written: 0,
		skipped: 0,
		closed: 0,
		deferred: 0,
		failed: 0,
		incomplete: false,
		summary: JSON.stringify(result),
	});
	core.summary.addHeading('PR baseline report', 3).addTable([
		[
			{ data: 'Baseline', header: true },
			{ data: 'Commit', header: true },
			{ data: 'On base', header: true },
			{ data: 'Binds', header: true },
		],
		...result.baselines.map((baseline) => [
			baseline.name,
			baseline.sha === null ? 'absent' : baseline.sha.slice(0, 12),
			baseline.onBase === null ? '' : baseline.onBase ? 'yes' : 'NO',
			String(baseline.bound),
		]),
	]);
	core.summary.addRaw(
		`\n${result.passing} passing, ${result.failing} failing, ${result.other} other, ${result.unstamped} unstamped.\n`,
	);
	if (result.stale !== undefined && result.current !== undefined) {
		core.summary.addRaw(
			`\n${result.current} PRs current, ${result.stale} stale, ${result.cosmetic ?? 0} differing only in wording or link.\n`,
		);
	}
	await writeSummary();
	if (result.offBase.length > 0) {
		core.setFailed(
			`Baseline ${result.offBase.join(', ')} is not on ${result.base}; fix the baseline.`,
		);
	}
}

function describeError(error: unknown): string {
	if (error instanceof ConfigError || error instanceof BaselineError) {
		return error.message;
	}
	if (isGitHubError(error)) {
		return error.kind === 'permission'
			? `${error.message} See the permissions table in the documentation.`
			: error.message;
	}
	return error instanceof Error ? error.message : String(error);
}
