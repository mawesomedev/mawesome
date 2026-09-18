# PR Baseline action

> Keep open pull requests current with a movable baseline on the base branch, reported through commit statuses.

**This repository is generated.** It mirrors [`actions/pr-baseline`](https://github.com/mawesomedev/mawesome/tree/main/actions/pr-baseline) in [mawesomedev/mawesome](https://github.com/mawesomedev/mawesome) with the bundled `dist/` and a `release.json` naming the release added; open issues and pull requests there. Full documentation lives in the package's [docs](https://github.com/mawesomedev/mawesome/tree/main/packages/pr-baseline/docs).

A repository-wide change lands on the base branch and every open PR branched before it keeps passing CI on stale code. This action marks that commit with a git ref under `refs/baselines/`, the **baseline**, and stamps open PRs with a commit status: `success` when the PR's head contains the baseline, `failure` when it does not. Require the status in the base branch's ruleset and stale PRs must merge or rebase before they can land. The baseline moves forward only by intent: a workflow dispatch, a merged PR carrying a label, or a push touching marker paths.

## Usage

One workflow, two jobs, both calling this action. Copy it, replace every `BASE` with your base branch, pin the action and `actions/checkout` to commit SHAs, and adjust `PR_BASELINES`.

<!-- workflow:start -->

```yaml
name: PR baseline
# Replace every BASE below with your base branch (for example main). The env context is unavailable
# in a job-level `if`, so the branch name is a literal in the marked places.
on:
  # Public repositories block `pull_request_target` by default from 2 November 2026.
  # Allow it for this workflow file under Settings > Actions > Policies to keep the instant per-PR status.
  # The job below checks nothing out and never runs PR code, which is the risk the block exists for.
  # Where the block stays, comment this trigger out and uncomment `pull_request` below.
  # Never enable both: a same-repo PR would then fire two runs.
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited]
  # The fallback stamps a same-repo PR as before, with two gaps the backfill job at the bottom covers.
  # A fork PR is not stamped at all: its run's token is read-only and the repository's secrets are withheld, so a custom token does not lift it.
  # A PR carrying a merge conflict fires no `pull_request` run at all, where `pull_request_target` still runs.
  #pull_request:
  #  types: [opened, synchronize, reopened, ready_for_review, edited]
  merge_group:
  push:
    branches: [BASE]
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        default: auto
        options: [auto, move-baseline, refresh-pr-statuses]
        description: auto recovers like the schedule; move-baseline forces a move and then refreshes; refresh-pr-statuses only refreshes open PR statuses
      baseline:
        type: string
        default: ''
        description: Name of one baseline to move; blank moves all
      scope:
        type: choice
        default: corrections
        options: [corrections, unstamped, all]
        description: Which open PRs a refresh covers; corrections is the PRs showing green, unstamped is the backfill
permissions: {}
env:
  # One source of truth for both jobs. Omit to use the single default baseline.
  PR_BASELINES: '[{"name":"pr-baseline","label":"Require PR update","markers":[".nvmrc"]}]'
jobs:
  refresh-pr-status:
    name: Refresh the PR status against the baseline
    if: >-
      !github.event.repository.fork &&
      (github.event_name == 'merge_group' || ((github.event_name == 'pull_request_target' || github.event_name == 'pull_request') && github.event.action != 'closed'))
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      statuses: write
    concurrency:
      group: pr-baseline-status-${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
      cancel-in-progress: false
    steps:
      - uses: mawesomedev/pr-baseline-action@<sha> # vX.Y.Z
        with:
          base: BASE
          baselines: ${{ env.PR_BASELINES }}
  refresh-pr-statuses:
    name: Move baselines and refresh PR statuses
    # A merge fires `push` on the base branch at the same moment, so a `closed` trigger would only run this twice.
    if: >-
      !github.event.repository.fork && (
        (github.event_name == 'push' && github.ref_name == 'BASE') ||
        github.event.schedule == '17 * * * *' ||
        github.event_name == 'workflow_dispatch'
      )
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: write
      statuses: write
      pull-requests: read
    concurrency:
      group: pr-baseline-refresh
      cancel-in-progress: false
      queue: max # Delete this line on GitHub Enterprise Server; one pending run is enough there.
    steps:
      - uses: actions/checkout@<sha> # vN
        with:
          ref: BASE
          fetch-depth: 0
          filter: tree:0
          persist-credentials: false
      - id: pr-baseline
        uses: mawesomedev/pr-baseline-action@<sha> # vX.Y.Z
        with:
          base: BASE
          baselines: ${{ env.PR_BASELINES }}
          mode: ${{ inputs.mode || 'auto' }}
          force: ${{ inputs.mode == 'move-baseline' }}
          baseline: ${{ inputs.baseline || '' }}
          scope: ${{ inputs.scope || '' }}
          # Leaves headroom in the shared hourly budget for the per-PR checks.
          max-writes-per-run: 300
# Uncomment during adoption to stamp the PRs nothing has reached yet, and watch `report`'s unstamped
# count fall. Keep it permanently only if the repository uses Dependabot AND stays on the default
# GITHUB_TOKEN, whose Dependabot runs cannot write. A custom App or PAT token is the better fix, but it
# must be stored as a Dependabot secret too: a Dependabot run cannot read the repository's Actions secrets.
# Keep it permanently as well when this workflow runs on `pull_request` in a public repository.
# A fork PR and a conflicted PR are reached by nothing else there, so pick a cron a required check can wait for.
# It needs its own tick: the example below is `- cron: '23 4 * * *'` under `on.schedule` above.
# Whichever cron you pick goes in both places, because the job's `if` tests for that exact string.
# Pick one that never coincides with the refresh's `17 * * * *`, which two different strings can still do.
# Each job matches its own cron, so the two then never start together.
# They still share the hour's write budget, which is what the two caps below and above are sized for.
#  backfill:
#    name: Stamp the PRs that have no status yet
#    if: ${{ !github.event.repository.fork && github.event.schedule == '23 4 * * *' }}
#    runs-on: ubuntu-latest
#    timeout-minutes: 60
#    permissions:
#      contents: read
#      statuses: write
#      pull-requests: read
#    concurrency:
#      group: pr-baseline-backfill
#      cancel-in-progress: false
#    steps:
#      - uses: actions/checkout@<sha> # vN
#        with:
#          ref: BASE
#          fetch-depth: 0
#          filter: tree:0
#          persist-credentials: false
#      - uses: mawesomedev/pr-baseline-action@<sha> # vX.Y.Z
#        with:
#          base: BASE
#          baselines: ${{ env.PR_BASELINES }}
#          mode: refresh-pr-statuses
#          scope: unstamped
#          # Well below the ceiling: a backfill must not starve every other workflow that writes a status.
#          max-writes-per-run: 150
```

<!-- workflow:end -->

The `refresh-pr-status` job never checks out code: the head SHA comes from the event. The `refresh-pr-statuses` job's treeless, full-history checkout gives the action the commit graph without trees or blobs, and the action fetches what else it needs itself, authenticated with the same token.

## Workflow execution protections

GitHub blocks `pull_request_target` in public repositories by default from 2 November 2026, under [workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections). A blocked run never starts, so the baseline status simply stops appearing on new PRs; the schedule keeps moving baselines either way. Private and internal repositories are unaffected.

Allow the event for this workflow file in an Actions event policy (Settings > Actions > Policies). The `refresh-pr-status` job checks nothing out and never runs PR code, which is the risk the default block exists for.

Where the policy stays, swap the trigger for `pull_request` as the template shows. A same-repo PR is stamped as before, with two gaps. A fork PR is not stamped at all: its run's token is read-only and the repository's secrets are withheld, so a custom App or PAT token does not lift the restriction either. A PR carrying a merge conflict fires no `pull_request` run at all, where `pull_request_target` still runs. Neither is reached by its own event, only by a refresh that covers unstamped PRs (`scope: unstamped`, or `all`), so enable the template's backfill job on a cron a required check can wait for, or dispatch one by hand; until it runs, those PRs sit on "Expected". Enabling both triggers is not a middle ground: a same-repo PR would fire two runs.

## Modes

`mode: auto` (the default) maps the event to a command:

| Event                                           | What runs                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request_target`, any type but `closed`    | `refresh-pr-status` on the PR head, status written. The supported path for fork PRs, where the repository's event policy allows the trigger.                                                                                                                                                                                                                                                                                    |
| any event, run triggered by Dependabot          | The workflow token is read-only: a PR is evaluated without writing, a move or refresh is skipped. The schedule makes the move, but nothing stamps that commit under the default scope: use a custom token, or a `scope: unstamped` backfill.                                                                                                                                                                                    |
| `pull_request_target` type `closed` and merged  | `move-baseline` (a labeled merge moves its baseline); the refresh that follows is suppressed when no baseline ref changed.                                                                                                                                                                                                                                                                                                      |
| `pull_request_target` type `closed`, not merged | Nothing, with a notice.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pull_request`                                  | `refresh-pr-status`; with the workflow token the status is written only for a same-repository PR not triggered by Dependabot. On a fork in `auto` mode an empty token, which is what a secret gives a fork run, is a no-op; any path that reaches the client still treats an empty token as an error. Without a usable custom token, a fork PR and a PR carrying a merge conflict are left to a refresh covering unstamped PRs. |
| `merge_group`                                   | `refresh-pr-status` on the merge group's head when its base is the configured branch; otherwise the `other-bases` rule applies.                                                                                                                                                                                                                                                                                                 |
| `push` to the base branch                       | `move-baseline` (path markers, merges made without a PR event); the refresh that follows is suppressed when no baseline ref changed.                                                                                                                                                                                                                                                                                            |
| `schedule`                                      | Non-forced `move-baseline` followed by a refresh that runs whether or not anything moved, which is the recovery net.                                                                                                                                                                                                                                                                                                            |
| `workflow_dispatch`                             | The same as `schedule`; the template's `mode` input passes `move-baseline` with `force` or `refresh-pr-statuses` explicitly.                                                                                                                                                                                                                                                                                                    |

Explicit modes (`refresh-pr-status`, `refresh-pr-statuses`, `move-baseline`, `report`) take the inputs as given; `refresh-pr-status` then needs `sha`. One rule still comes from the event: a pinned `mode: move-baseline` on a base-branch push or a merged `pull_request_target` skips its refresh when no baseline ref changed, exactly as `auto` does, so pinning the mode does not bring back a refresh on every push.

## Inputs

<!-- inputs:start -->

| Input                            | Description                                                                                                                                                                                  | Default               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `token`                          | Token used for every read and write; defaults to the workflow's own token.                                                                                                                   | `${{ github.token }}` |
| `mode`                           | What to do: auto (from the event), refresh-pr-status, refresh-pr-statuses, move-baseline or report.                                                                                          | `auto`                |
| `sha`                            | Commit to evaluate in refresh-pr-status mode; auto takes it from the event.                                                                                                                  |                       |
| `base`                           | Base branch; defaults to the repository's default branch.                                                                                                                                    |                       |
| `baselines`                      | JSON array of `{ name, label?, scope?, markers? }`, inline only; cannot be combined with name, label or markers.                                                                             |                       |
| `name`                           | Shorthand for a single baseline's name (default `pr-baseline`).                                                                                                                              |                       |
| `label`                          | Shorthand for a single baseline's label (default `Require PR update`).                                                                                                                       |                       |
| `markers`                        | Shorthand for a single baseline's auto-move patterns, one gitignore pattern per line.                                                                                                        |                       |
| `baseline`                       | In move-baseline mode, move only the baseline with this name; blank moves all.                                                                                                               |                       |
| `scope`                          | Which open PRs a refresh covers: corrections (default, the green ones), unstamped (the backfill) or all.                                                                                     |                       |
| `status-context`                 | Status context (default `PR baseline`).                                                                                                                                                      |                       |
| `description-pass`               | Description of a passing status; `{base}` and `{baselines}` are replaced.                                                                                                                    |                       |
| `description-fail`               | Description of a failing status; `{base}` and `{baselines}` are replaced.                                                                                                                    |                       |
| `description-not-applicable`     | Description written for PRs against other branches when other-bases is pass.                                                                                                                 |                       |
| `target-url`                     | Link attached to every status; by default a failing status links to the compare view of what it lacks.                                                                                       |                       |
| `other-bases`                    | PRs against other branches: skip (default) or pass.                                                                                                                                          |                       |
| `creator`                        | Login the token writes statuses as; required for a GitHub App token.                                                                                                                         |                       |
| `ancestry`                       | Ancestry source: auto (default), git or api.                                                                                                                                                 |                       |
| `max-writes-per-run`             | Stop a refresh after this many status writes; a positive integer (default 450).                                                                                                              |                       |
| `max-writes-per-minute`          | Pace status writes; a positive integer per minute (default 60).                                                                                                                              |                       |
| `dry-run`                        | Log every intended write and baseline move instead of making it.                                                                                                                             | `false`               |
| `force`                          | In move-baseline mode, move by intent alone and seed absent baselines.                                                                                                                       | `false`               |
| `refresh-pr-statuses-after-move` | In move-baseline mode, refresh open PR statuses afterwards (default true). On a base-branch push or a merged pull_request_target the refresh is skipped anyway when no baseline ref changed. | `true`                |

<!-- inputs:end -->

`token` defaults to the workflow's own token. With a GitHub App token, pass `creator` (the App's `<slug>[bot]` login); with a personal access token the creator is resolved from the token.

## Outputs

<!-- outputs:start -->

| Output            | Description                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`           | Status state of the checked commit (`success` or `failure`), or of the run (`success`, `failure`, `skipped` or `error`).                                                                                                       |
| `description`     | Status description of the checked commit.                                                                                                                                                                                      |
| `base`            | The base branch the run served.                                                                                                                                                                                                |
| `baselines`       | JSON array of `{ name, sha }` for every configured baseline.                                                                                                                                                                   |
| `missing`         | JSON array of baseline names the evaluated commit lacks (refresh-pr-status mode).                                                                                                                                              |
| `written`         | Statuses written.                                                                                                                                                                                                              |
| `skipped`         | PRs whose status was already current.                                                                                                                                                                                          |
| `closed`          | Selected PRs that closed while the refresh ran.                                                                                                                                                                                |
| `deferred`        | PRs whose head was still moving.                                                                                                                                                                                               |
| `failed`          | PRs whose status could not be written.                                                                                                                                                                                         |
| `scope`           | The scope a refresh applied; `all` whatever was asked when a baseline is off the base branch, after a forced move, or with a custom reporter.                                                                                  |
| `selected`        | Open PRs the scope selected.                                                                                                                                                                                                   |
| `excluded`        | Open PRs the scope left out.                                                                                                                                                                                                   |
| `cosmetic`        | Selected PRs whose status differed only in description or link, so no write was spent.                                                                                                                                         |
| `remaining`       | Selected PRs the run never reached.                                                                                                                                                                                            |
| `moved`           | Whether any baseline moved in this run (`true` or `false`).                                                                                                                                                                    |
| `moved-baselines` | JSON array of the baseline names that moved.                                                                                                                                                                                   |
| `incomplete`      | Whether a refresh stopped before covering every selected PR (`true` or `false`).                                                                                                                                               |
| `paused`          | Whether a refresh stopped on a budget having written something, with nothing failed or deferred (`true` or `false`). The step stays green unless something else fails it; a run at the same scope continues where it left off. |
| `summary`         | JSON summary of the run, per-PR results capped to stay under the output size limit.                                                                                                                                            |
| `results-file`    | Path of a JSON file with the uncapped per-PR results of a refresh, for an upload step.                                                                                                                                         |

<!-- outputs:end -->

Every run, including a skip or an error, sets every output and writes a step summary. `summary` is a JSON string a following step can turn into a comment or a check run; `results-file` holds the uncapped per-PR results of a refresh for an artifact upload.

## Permissions

| Job                   | `contents` | `statuses` | `pull-requests` |
| --------------------- | ---------- | ---------- | --------------- |
| `refresh-pr-status`   | read       | write      |                 |
| `refresh-pr-statuses` | write      | write      | read            |

Require the status context (`PR baseline` by default) in the base branch's ruleset only, with the source matching the token. The baseline refs live under `refs/baselines/`, which no clone fetches and no ruleset covers: whoever has `contents: write` can move them, and the tool only ever fast-forwards them. The package docs cover [permissions](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/permissions.md), [rate limits](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/rate-limits.md), [edge cases](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/edge-cases.md) and the [runbook](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/runbook.md).

## Support

GitHub.com is the primary target. GitHub Enterprise Server works through the runner's `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` and `GITHUB_SERVER_URL`; the action is reachable through GitHub Connect or a local mirror. The action runs on the `node24` runtime and needs git 2.45 or newer on the runner for git ancestry.

## License

[MIT](./LICENSE)
