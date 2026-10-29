/**
 * Public types for @mawesome/pr-baseline.
 */

/** One baseline: a movable ref, optionally bound to a label, a PR path scope and auto-move markers. */
export interface Baseline {
	/** Name under `refs/baselines/` of the ref that marks the required commit on the base branch. */
	name: string;
	/** A merged PR carrying this label moves the baseline to its merge commit. */
	label?: string;
	/** gitignore-style patterns; when present the baseline binds only PRs whose diff touches them. */
	scope?: string[];
	/** gitignore-style patterns; a base push touching them moves the baseline automatically. */
	markers?: string[];
}

/** A baseline with its current commit; `sha` is null when the ref does not exist. */
export interface ResolvedBaseline extends Baseline {
	sha: string | null;
}

export type StatusState = 'success' | 'failure' | 'error' | 'pending';

/** A commit status as read back from GitHub for one context. */
export interface StatusRecord {
	state: StatusState;
	description: string | null;
	targetUrl: string | null;
	creator: string | null;
}

/** The status the tool intends to write for a commit. */
export interface StatusPayload {
	state: 'success' | 'failure';
	description: string;
	targetUrl: string | undefined;
}

export type VerdictKind = 'pass' | 'fail' | 'not-applicable' | 'misconfigured';

export interface Verdict {
	kind: VerdictKind;
	status: StatusPayload;
	/** Names of applicable baselines the commit does not contain. */
	missing: string[];
	/** Names of the baselines that bind the commit. */
	applicable: string[];
}

export type AncestryMode = 'auto' | 'git' | 'api';

export type OtherBases = 'skip' | 'pass';

/** Which open PRs a refresh brings in line. */
export type RefreshScope =
	/** PRs whose status is green, the only ones a forward baseline move can turn red. Default. */
	| 'corrections'
	/** PRs with no status on the context; the adoption and Dependabot backfill. */
	| 'unstamped'
	/** Every in-scope open PR. */
	| 'all';

/** What a command is about to ask, so an adapter can fetch in batches and verify the baseline refs first. */
export interface PrepareInput {
	/** Commits the run will ask about, such as the base head. */
	shas: string[];
	/** Open PRs whose heads the run will evaluate. */
	pulls: number[];
	/** Every baseline with the SHA the API reported, null when absent; an adapter with its own view must agree. */
	refs: Array<{ name: string; sha: string | null }>;
	/** The commits of `shas` the remote may no longer serve; those are reported in `missing` instead of failing. */
	optional?: string[];
}

export interface PrepareResult {
	/** Each PR's head as the adapter sees it now; null when the PR's ref is gone. Empty for adapters that cannot tell. */
	heads: Map<number, string | null>;
	/** The `optional` commits the remote does not serve; absent when the adapter cannot tell. */
	missing?: string[];
}

/** Answers ancestry and changed-file questions for commits of one repository. */
export interface Ancestry {
	/** The adapter's name, reported in results. */
	readonly name: 'git' | 'api';
	/** Whether `ancestor` is reachable from `descendant`; a commit is its own ancestor. */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	/**
	 * Files changed on `to` since its merge base with `from` (three-dot semantics).
	 * Returns null when the answer is indeterminate, as with the compare API's 300-file cap.
	 */
	changedFiles(from: string, to: string): Promise<string[] | null>;
	/**
	 * Optional batch step run before the commits it names are asked about; adapters without one are asked commit by commit.
	 * `refresh-pr-statuses` calls it for the base head, then for the PR heads its scope selected, then once per PR whose pull ref lags the API head.
	 */
	prepare?(input: PrepareInput): Promise<PrepareResult>;
}

/** Reads and writes the tool's status for commits of one repository. */
export interface Reporter {
	/** The latest status for the configured context on a commit, if any. */
	current(sha: string): Promise<StatusRecord | null>;
	/** Writes a status; resolves once the write is confirmed. */
	write(sha: string, status: StatusPayload): Promise<void>;
}

export interface DescriptionTemplates {
	pass: string;
	fail: string;
	notApplicable: string;
}

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
}

/** Options accepted by `createClient`; unset values fall back to env and repository defaults. */
export interface ClientOptions {
	/** `owner/name`; defaults to `GITHUB_REPOSITORY`. */
	repo?: string;
	/** Defaults to `GITHUB_TOKEN`. */
	token?: string;
	/** Defaults to `GITHUB_API_URL`, then `https://api.github.com`. */
	apiUrl?: string;
	/** Defaults to `GITHUB_GRAPHQL_URL`, then the GraphQL endpoint matching `apiUrl`. */
	graphqlUrl?: string;
	/** The git server the token may be sent to; defaults to `GITHUB_SERVER_URL`, then the host behind `apiUrl`. */
	serverUrl?: string;
	/** Base branch; defaults to the repository's default branch. */
	base?: string;
	/** Baselines; defaults to one unscoped baseline with the default name and label. */
	baselines?: Baseline[];
	/** Status context; defaults to `PR baseline`. */
	context?: string;
	descriptions?: Partial<DescriptionTemplates>;
	targetUrl?: string;
	ancestry?: AncestryMode;
	gitDir?: string;
	otherBases?: OtherBases;
	/** Which open PRs `refreshPrStatuses` covers; defaults to `corrections`. */
	scope?: RefreshScope;
	/** Login the statuses are written as; resolved from the token when unset. */
	creator?: string;
	/** Set when the token is provably the workflow's own `github.token`. */
	tokenIsWorkflowToken?: boolean;
	/** Trust the baseline refs in the local clone when no token can confirm them. */
	offline?: boolean;
	maxWritesPerRun?: number;
	maxWritesPerMinute?: number;
	dryRun?: boolean;
	includeDrafts?: boolean;
	fetch?: typeof fetch;
	ancestryAdapter?: Ancestry;
	reporter?: Reporter;
	logger?: Logger;
	/** Injectable sleep for write pacing. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable clock for pacing. */
	now?: () => number;
	/** Base delay in milliseconds for retrying transient server errors; default 1000. */
	retryBaseMs?: number;
	env?: Record<string, string | undefined>;
}

export interface RefreshPrStatusOptions {
	/** Commit SHA or ref to evaluate; defaults to `HEAD` of the local repository. */
	sha?: string;
	/** Evaluate a pull request's head instead of `sha`. */
	pr?: number;
	/** The branch `sha` targets when known without a PR, as a merge queue's `base_ref`; applies the other-bases rule. */
	baseRef?: string;
	/** Write the status; defaults on for `pr` and off for a commit given directly. */
	report?: boolean;
}

export interface RefreshPrStatusResult {
	sha: string;
	base: string;
	verdict: Verdict;
	baselines: ResolvedBaseline[];
	/** Whether the run wrote a status. */
	written: boolean;
	/** Whether the status was already current, so nothing was written. */
	skipped: boolean;
	/** The PR was out of scope and no status was written. */
	outOfScope: boolean;
	ancestry: 'git' | 'api';
}

export type RefreshOutcome =
	| 'written'
	| 'skipped'
	/** Differed only in description or target URL, which gates nothing, so no write was spent. */
	| 'cosmetic'
	| 'closed'
	| 'deferred'
	| 'failed'
	| 'out-of-scope';

export interface RefreshEntry {
	number: number;
	sha: string;
	outcome: RefreshOutcome;
	verdict?: Verdict;
	error?: string;
}

export type RefreshStopReason =
	| 'rate-limit'
	| 'write-cap'
	| 'primary-budget'
	| 'deferred'
	| 'failed';

export interface RefreshPrStatusesResult {
	base: string;
	baselines: ResolvedBaseline[];
	/** Open in-scope PRs as the first listing saw them, before the scope and any reconciliation. */
	openPulls: number;
	/** The scope the run applied, which is `all` whatever was asked when a baseline is off the base branch. */
	scope: RefreshScope;
	/** Open PRs the scope selected. */
	selected: number;
	/** `openPulls - selected`. */
	excluded: number;
	/** Baselines that are no longer on the base branch; every PR then carries the misconfiguration pass. */
	misconfigured: string[];
	written: number;
	skipped: number;
	/** Selected PRs whose status differed only in description or link, left alone outside `all`. */
	cosmetic: number;
	closed: number;
	deferred: number;
	/** PRs that left the base branch or became drafts while the refresh was preparing. */
	outOfScope: number;
	failed: number;
	/** Selected PRs the run never reached, which is what the next run has left to do. */
	remaining: number;
	incomplete: boolean;
	/** The run stopped on a budget having made progress, so the next run continues; a green ending. */
	paused: boolean;
	reason?: RefreshStopReason;
	entries: RefreshEntry[];
	ancestry: 'git' | 'api';
	dryRun: boolean;
}

export interface MoveBaselineOptions {
	/** Move by intent alone, seeding absent baselines; never a ref force. */
	force?: boolean;
	/** Target commit; defaults to base HEAD. */
	to?: string;
	/** Restrict to one baseline by name. */
	baseline?: string;
	/** Refresh open PR statuses afterwards. */
	refreshPrStatuses?: boolean;
	/**
	 * Whether that refresh still runs when no baseline ref changed; default true.
	 * The action passes false for the events that fire on every base-branch push, and leaves it true
	 * for the schedule and dispatches, which are the recovery net.
	 */
	refreshWhenUnchanged?: boolean;
}

export type MoveReason = 'forced' | 'label' | 'markers';

export interface MoveEntry {
	name: string;
	from: string | null;
	to: string;
	moved: boolean;
	reason?: MoveReason;
	/** How a moved ref was written: a lease push through git, or the refs API. Absent in a dry run. */
	via?: 'git' | 'api';
	/** Set when the baseline was left alone; human readable. */
	note?: string;
}

export interface MoveBaselineResult {
	base: string;
	head: string;
	/** Every configured baseline with its SHA after the moves. */
	baselines: ResolvedBaseline[];
	moves: MoveEntry[];
	refresh?: RefreshPrStatusesResult;
	dryRun: boolean;
}

export interface ReportBaseline extends ResolvedBaseline {
	/** Whether the baseline's commit is an ancestor of base HEAD; null when the ref is absent. */
	onBase: boolean | null;
	/** Open PRs the baseline binds. */
	bound: number;
}

export interface ReportResult {
	base: string;
	head: string;
	baselines: ReportBaseline[];
	/** Baselines whose commit is not on the base branch; the CLI exits 2 when non-empty. */
	offBase: string[];
	openPulls: number;
	/** Open PRs whose status on the context is green. */
	passing: number;
	/** Open PRs whose status on the context is a failure. */
	failing: number;
	/** Open PRs carrying an `error` or `pending` status, which blocks a merge and which only `--scope all` reaches. */
	other: number;
	/** Open PRs with no status on the context, which a required check blocks with "Expected". */
	unstamped: number;
	/** PRs whose status differs materially from the intended one; only computed with the git adapter. */
	stale?: number;
	/** PRs differing only in description or link, which every scope but `all` leaves alone on purpose. */
	cosmetic?: number;
	current?: number;
	ancestry: 'git' | 'api';
}
