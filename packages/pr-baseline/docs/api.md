# Programmatic API

The CLI and the action are thin consumers of this API, so everything they do is available to your own integration.

```ts
import { createClient } from '@mawesome/pr-baseline';

const client = createClient({
	repo: 'owner/name',
	token: process.env.GITHUB_TOKEN,
	baselines: [{ name: 'pr-baseline', label: 'Require PR update', markers: ['.nvmrc'] }],
	creator: 'github-actions[bot]',
});

await client.refreshPrStatus({ pr: 42 });
await client.refreshPrStatuses();
await client.moveBaseline({ force: true, refreshPrStatuses: true });
await client.report();
```

## `createClient(options)`

Resolves the configuration (flags over `env` over defaults) and throws `ConfigError` for anything invalid before a single request is made. The base branch and the status creator are resolved lazily by the commands that need them. `client.config` exposes the resolved configuration.

`ClientOptions` mirrors the [CLI options](./cli.md) in camelCase (`apiUrl`, `otherBases`, `maxWritesPerRun`, `descriptions.{pass,fail,notApplicable}`, ...) plus:

| Option                 | Purpose                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                | Injectable `fetch`, for tests and custom transports.                                                                                        |
| `ancestryAdapter`      | An `Ancestry` implementation replacing the built-in adapters.                                                                               |
| `reporter`             | A `Reporter` implementation replacing commit statuses.                                                                                      |
| `logger`               | `{ info, warn }`; defaults to stderr.                                                                                                       |
| `sleep`, `now`         | Injectable clock and sleep for write pacing.                                                                                                |
| `retryBaseMs`          | Base delay for retrying transient server errors (three attempts, quadratic backoff); default 1000.                                          |
| `env`                  | Environment to read fallbacks from; defaults to `process.env`.                                                                              |
| `tokenIsWorkflowToken` | Set by the action when `token` is provably the workflow's own token, which resolves the creator to `github-actions[bot]` without a request. |
| `includeDrafts`        | Whether draft PRs are refreshed; default `true`. Not exposed by the CLI.                                                                    |

## Commands

- `refreshPrStatus(options?: RefreshPrStatusOptions): Promise<RefreshPrStatusResult>` with `sha`, `pr`, `baseRef` (the branch a bare commit targets, so the `otherBases` rule applies) and `report`.
- `refreshPrStatuses(): Promise<RefreshPrStatusesResult>`; which PRs it covers comes from `ClientOptions.scope` (`corrections` by default, `unstamped` or `all`).
- `moveBaseline(options?: MoveBaselineOptions): Promise<MoveBaselineResult>` with `force`, `to`, `baseline`, `refreshPrStatuses` and `refreshWhenUnchanged` (default true; false skips the refresh when no baseline ref changed, which is what the action passes for the events that fire on every base-branch push).
- `report(): Promise<ReportResult>`.

Each result carries the base branch and the resolved baselines (`{ name, sha }` with `sha: null` for an absent baseline; after `moveBaseline`, the SHAs after the moves). `RefreshPrStatusResult.verdict` holds the verdict, `RefreshPrStatusesResult.entries` lists every PR the refresh reached with its outcome (`written`, `skipped`, `cosmetic`, `closed`, `deferred`, `out-of-scope`, `failed`, with matching counters including `outOfScope`; a refresh stopped by a budget or a rate limit lists only the PRs before the stop), `scope`, `selected`, `excluded` and `remaining` say what the run covered and what is left, `MoveBaselineResult.moves` says what moved and why, each entry moved outside a dry run carrying `via`, whether the ref was written by a lease push through git (`git`) or through the refs API (`api`), and `ReportResult.offBase` names baselines that left the base branch, alongside a `passing`/`failing`/`other`/`unstamped` breakdown of the open PRs and, with the git adapter, every baseline on the base branch and a resolvable creator, `current`, `stale` and `cosmetic` (all three absent otherwise).

## Ports

```ts
interface Ancestry {
	readonly name: 'git' | 'api';
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	/** Files changed on `to` since its merge base with `from`; null when indeterminate. */
	changedFiles(from: string, to: string): Promise<string[] | null>;
	/** Optional batch step before any evaluation: fetch what will be asked about and verify the baseline refs. */
	prepare?(input: PrepareInput): Promise<PrepareResult>;
}

interface Reporter {
	current(sha: string): Promise<StatusRecord | null>;
	write(sha: string, status: StatusPayload): Promise<void>;
}
```

`PrepareInput` carries the commits the run will ask about, the open PR numbers and every baseline name with the SHA the API reported (null when absent); `PrepareResult.heads` maps each PR to the head the adapter fetched, null when its ref is gone. `PrepareInput.optional` names the commits of `shas` the remote may no longer serve; an adapter that can tell lists those it could not get in `PrepareResult.missing` instead of failing, and one that cannot simply prepares them through `shas`. Every command calls it before asking about the commits it names (`refresh-pr-status` and `move-baseline` with an empty `pulls` list, `refresh-pr-status` offline with an empty `refs` list, `move-baseline` once more with the labeled merge candidates it found). `refresh-pr-statuses` calls it first for the base head with no PRs, because the scope cannot be settled until the baselines have been checked against that head, then for the selected PR heads alone, then once more per PR whose pull ref lags the head the API reports, with that head in `shas` and `optional`; the built-in git adapter uses it to fetch in batches and to refuse when a baseline ref on the remote disagrees with the API.

A custom reporter can post a comment, create a check run or forward to a hosted service. `refresh-pr-status` and `refresh-pr-statuses` compare `current()` against the intended status by state, description, target URL and creator, so a reporter that stores no creator should return the configured one. `compareStatus` classes a difference in state or creator as material and one in description or target URL alone as cosmetic; `refresh-pr-status` writes either, and `refreshPrStatuses` spends a write on a cosmetic one only under `scope: 'all'`. A custom reporter always refreshes every PR, since the PR listing's commit statuses are not the reporter's; passing a `scope` other than `'all'` with one is a `ConfigError` from `refreshPrStatuses`, and from `moveBaseline` before it moves anything. The other commands ignore `scope`, so one client still serves them all. The built-in status reporter is the one exception: the refresh reads its current statuses from the PR listing (one GraphQL page per 100 PRs, two with the git adapter) instead of calling `current()` per PR.

## Errors

- `ConfigError`: invalid or missing configuration, including an unresolvable creator or a write that came back under another login. Exit code 2 in the CLI.
- `BaselineError`: a repository state the tool refuses to act on, such as a target that does not descend from the current baseline. Exit code 2.
- `GitHubError`: a failed request, with `kind` in `rate-limit`, `auth`, `permission`, `not-found`, `conflict`, `status-cap`, `validation`, `server` (any 5xx after the retries), `network`, `other`, plus `status`, `path`, `body` and `retryAfterMs`. `isGitHubError(error, kind?)` narrows it.

## Pure helpers

`computeVerdict`, `renderDescription`, `boundDescription`, `compareStatus`, `sameRefs`, `createProgressThrottle`, `validateBaselines`, `parseBaselines`, `shorthandBaselines` and `createMatcher` are exported for tests and for integrations that want the same decisions without the client.
