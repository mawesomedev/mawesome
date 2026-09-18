# GitHub Action

The action is one root action, [`mawesomedev/pr-baseline-action`](https://github.com/mawesomedev/pr-baseline-action), with a `mode` input. Its source is the [`actions/pr-baseline`](https://github.com/mawesomedev/mawesome/tree/main/actions/pr-baseline) workspace; the mirror carries only what a consumer runs, which is `action.yml`, the bundled `dist/`, the README, the workflow template, the licence, and a `release.json` naming the version and the commit it was built from. The workflow and the tables below are generated from [`action.yml`](https://github.com/mawesomedev/mawesome/tree/main/actions/pr-baseline/action.yml) and the [workflow template](https://github.com/mawesomedev/mawesome/tree/main/actions/pr-baseline/workflow-template.yml), the same sources as the action's own [README](https://github.com/mawesomedev/mawesome/tree/main/actions/pr-baseline/README.md).

## Usage

One workflow, two jobs, both calling the action. Copy it, replace every `BASE` with your base branch, pin the action and `actions/checkout` to commit SHAs, and adjust `PR_BASELINES`. [Permissions](./permissions.md) covers the tokens and the rulesets, the [runbook](./runbook.md) the rollout order.

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

The `refresh-pr-status` job serves PR and merge-queue events, the `refresh-pr-statuses` job serves base pushes, labeled merges, the schedule and dispatches. `BASE` is a literal in the marked places because the `env` context is unavailable in a job-level `if`. The baseline list is defined once in the workflow-level `env` and read by both steps. Both jobs carry a `!github.event.repository.fork` guard, the `refresh-pr-status` job never checks out code, and the `refresh-pr-statuses` job checks out a treeless full-history clone with `persist-credentials: false`; the action authenticates its own fetches. Job names must not resemble the status context; require the context, not the job.

## Workflow execution protections

GitHub blocks `pull_request_target` in public repositories by default from 2 November 2026, under [workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections). A blocked run never starts, so the baseline status simply stops appearing on new PRs; the schedule keeps moving baselines either way. Private and internal repositories are unaffected.

Allow the event for this workflow file in an Actions event policy (Settings > Actions > Policies). The `refresh-pr-status` job checks nothing out and never runs PR code, which is the risk the default block exists for.

Where the policy stays, swap the trigger for `pull_request` as the template shows. A same-repo PR is stamped as before, with two gaps. A fork PR is not stamped at all: its run's token is read-only and the repository's secrets are withheld, so a custom App or PAT token does not lift the restriction either. A PR carrying a merge conflict fires no `pull_request` run at all, where `pull_request_target` still runs. Neither is reached by its own event, only by a refresh that covers unstamped PRs (`scope: unstamped`, or `all`), so enable the template's backfill job on a cron a required check can wait for, or dispatch one by hand; until it runs, those PRs sit on "Expected". Enabling both triggers is not a middle ground: a same-repo PR would fire two runs.

## Modes

`mode` is `auto` (default), `refresh-pr-status`, `refresh-pr-statuses`, `move-baseline` or `report`. In `auto` the event decides:

| Event                                                  | Mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pull_request_target`, any type except `closed`        | `refresh-pr-status` on the payload head SHA, reporting on. The supported write path for fork PRs, where the repository's event policy allows the trigger.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pull_request_target` type `closed`, `merged == true`  | `move-baseline --refresh-pr-statuses`, the immediate path for a labeled merge. The refresh is suppressed when no baseline ref changed, since a merge also fires `push`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `pull_request_target` type `closed`, `merged == false` | No-op with a notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pull_request`                                         | `refresh-pr-status`; with the workflow token the status is written only for a same-repository PR not triggered by Dependabot, since the token is read-only otherwise. Any other token writes. On a fork in `auto` mode an empty token, which is what a secret gives a fork run, is a no-op; any path that reaches the client still treats an empty token as an error. A payload without a PR is a no-op. Without a usable custom token, a fork PR on this trigger, and a PR carrying a merge conflict, are reached only by a refresh covering unstamped PRs. |
| `merge_group`                                          | `refresh-pr-status` on `merge_group.head_sha` when `merge_group.base_ref` is the base branch; otherwise the `other-bases` rule applies, so a queue for another branch is skipped by default.                                                                                                                                                                                                                                                                                                                                                                 |
| `push` to the base branch                              | `move-baseline --refresh-pr-statuses` for path markers and merges made without a `pull_request_target` run, with the refresh suppressed when no baseline ref changed, so a push that moved nothing costs only the checkout and the move decision. The base defaults to the payload's default branch; a push to any other ref is a no-op.                                                                                                                                                                                                                     |
| `schedule`                                             | `move-baseline --refresh-pr-statuses`, non-forced, and the refresh runs whether or not anything moved: this is the net under a lost, paused or suppressed run, and the only thing that converges drift no move reports.                                                                                                                                                                                                                                                                                                                                      |
| `workflow_dispatch`                                    | The same non-forced `move-baseline --refresh-pr-statuses` as `schedule`. The template's `mode` choice input passes `move-baseline` with `force` or `refresh-pr-statuses` explicitly, so the action never reads dispatch inputs.                                                                                                                                                                                                                                                                                                                              |

An explicit `mode` takes the inputs as given, with one rule still coming from the event: a pinned `mode: move-baseline` on a base-branch push or a merged `pull_request_target` skips its refresh when no baseline ref changed, exactly as `auto` does.

## Inputs and outputs

Inputs mirror the [CLI](./cli.md), except that `baselines` is inline JSON only and `markers` is multiline. The API, GraphQL and server URLs come from the runner's environment, so GitHub Enterprise Server needs no extra input.

A hidden `github-token-probe` input, defaulting to `${{ github.token }}` like `token`, lets the action prove whether `token` is the workflow's own token: when the two are equal the status creator is `github-actions[bot]` without any request; an App token never matches and must come with `creator`.

Outputs are plain strings, several of them JSON documents. Every run, including a skip or an error, sets every output and writes a step summary; `state` is then `skipped` or `error`. The `summary` output of a refresh drops per-PR entries until it fits a quarter of GitHub's 1 MB output cap and says how many it omitted; after a move it also carries the moves. A run Dependabot triggers has a read-only workflow token, so it evaluates without writing and leaves moves to the schedule. Nothing else stamps that commit: the scheduled refresh covers the green PRs, not the unstamped ones. Give the action a custom App or PAT token, which lifts the restriction entirely, or schedule a `scope: unstamped` backfill; without one of the two, Dependabot PRs stay on "Expected" indefinitely, and their author cannot push a fix. A custom token has to be stored as a **Dependabot** secret as well as an Actions one: a Dependabot-triggered run cannot read Actions secrets, so a token kept only there is empty on the runs that need it. An incomplete refresh that is not paused, an off-base baseline in `report`, a configuration error and a permission error fail the step; a paused refresh warns and leaves the step green, with `incomplete` still `true`; a failing `refresh-pr-status` verdict does not, since the commit status is the gate, and an off-base baseline in a refresh fails it only while some PR still has to learn it: the run that writes the misconfiguration pass fails, later runs, which write nothing, warn instead. A repository with no open PRs has nowhere else to carry the message, so its run always fails.

### Inputs

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

### Outputs

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

## Building and testing

`pnpm --filter @mawesome/pr-baseline-action build` bundles `src/main.ts` into `dist/index.js` (ESM, node24, every dependency bundled, third-party licenses in `licenses.txt`); `dist/` is committed only in the mirror. `pnpm readme` in that workspace regenerates the tables and the workflow in the README and on this page from `action.yml` and the template, and `--check` fails CI when they drift. The action tests run the entry in-process with `INPUT_*` variables and event payload fixtures against the fake API, one per row of the mode table, plus the creator migration fixture; a second suite builds the bundle and runs `dist/index.js` in a subprocess against the fake API served over HTTP for the main rows, so a bundling regression cannot pass on source alone.

## Release and mirror

The action is a private workspace with its own changeset, changelog and version, so a library release and an action release are separate events. The changesets tag for the action, `@mawesome/pr-baseline-action@X.Y.Z`, triggers the monorepo's `deploy-to-mirror` workflow, which is generic over the `actions/*` workspaces: the tag names the package and the version, and the workspace manifest's `mirror` key names the repository to publish to and the files that reach it. The workflow checks out the tagged commit, requires it on `main` with a manifest at that exact version, builds the bundle, and stages the listed files with `dist/`, a generated `package.json` and a `release.json` naming the version and that commit. It then checks the mirror out with `actions/checkout` and the App token and runs `tools/repo/scripts/deploy-to-mirror.ts publish`, which replaces the checkout's contents with the stage, commits that tree on the mirror's `main` as the App's bot user with the subject `Release vX.Y.Z` and an `Upstream-Ref` footer, and moves `main`, `vX.Y.Z` and `vX` in one atomic push leased on the values it read, so any failure leaves every ref untouched. Reruns are safe: an existing `vX.Y.Z` with the same tree only reconciles `vX`, a release commit whose tag was deleted is retagged in place, a version older than the one `vX` names is refused, and a `vX` that has already moved past the release is left alone. A lost run is repeated by dispatching the workflow with the package and version; a release whose tag never landed is repaired by creating the tag on the released commit, which triggers the workflow.

The first publication needs the mirror repository, `mawesomedev/pr-baseline-action`, created by hand with an empty initial commit on `main`, the release App installed on it, and rulesets there restricting `main` and `v*` to the App. In the monorepo, a tag ruleset must restrict `@mawesome/*-action@*` to the App and the `action-mirror` environment must be limited to that tag pattern and the `main` branch, because the workflow runs the code of the commit the tag names. A run that dies leaves nothing behind to clean up, since the mirror's refs move only in the final push; rerun it.

## Support matrix

| Platform                 | Support                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub.com               | Primary target.                                                                                                                                                                                                                                                                                                                                                                                             |
| GitHub Enterprise Cloud  | Same as GitHub.com; higher rate limits for enterprise-owned repositories.                                                                                                                                                                                                                                                                                                                                   |
| GitHub Enterprise Server | Through the runner's `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` and `GITHUB_SERVER_URL`; reach the action through GitHub Connect or a local mirror. `concurrency.queue` is not available there: delete the `queue: max` line from the `refresh-pr-statuses` job, which then keeps a single pending run; that is safe because labeled merges are scanned cumulatively and the schedule recovers a coalesced run. |
| Runner                   | `node24` runtime; git 2.45 or newer for git ancestry, otherwise the API adapter is used with a warning. A baseline move is a lease push through git, from the checkout or from a temporary repository, with the refs API as the last resort when both fail; every path needs `contents: write`.                                                                                                             |
