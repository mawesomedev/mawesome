# Runbook

## Rollout

1. **Create the label** each baseline uses (`Require PR update` by default) so maintainers can mark a PR whose merge should move the baseline.
2. **Run the refresh unseeded.** With no baseline ref every open PR passes, so `refresh-pr-statuses --scope all` stamps them all green. This proves the token, the creator and the permissions before anything can block. The default scope would select nothing here, since no PR carries a status yet.
3. **Seed the baseline** at the commit that every open PR must contain: `pr-baseline move-baseline --force --refresh-pr-statuses`, or `--to <sha>` for an older commit. The refresh stamps stale PRs with a failure.
4. **Let it converge.** A large repository may need more than one run because of the write budget; each run reports what is left. `pr-baseline report` shows the baseline and how many PRs it binds.
5. **Require the status context** in the base branch's ruleset with the source matching the token, as described in [permissions](./permissions.md).

## Everyday operations

- **Move on demand:** `pr-baseline move-baseline --force --refresh-pr-statuses` (a workflow dispatch with mode `move-baseline` in the action).
- **Retry an incomplete refresh:** run `refresh-pr-statuses` again, or dispatch the workflow. Every status already written is current and skipped, so retries are cheap. A run that stopped on a budget having written something is paused rather than failed, and the next run **at the same scope** continues it: a paused backfill needs the backfill schedule, not the ordinary one, and a paused sweep that a forced move promoted to `all` needs `--scope all` passed by hand, since the move that promoted it will not repeat. The closing line says so when it applies.
- **Check what is stale:** `pr-baseline report`. It always breaks the open PRs into passing, failing, other and unstamped; with the git adapter it also counts current, stale and cosmetic.
- **See the ref itself:** `git ls-remote origin 'refs/baselines/*'`. The refs have no page in the GitHub UI and no clone fetches them on its own.
- **Move one baseline of several:** `--baseline <name>`.
- **Gate a job on a move:** the action's `moved` and `moved-baselines` outputs say whether anything moved and which baselines did.
- **Stamp the PRs nothing has reached yet:** `refresh-pr-statuses --scope unstamped`, throttled with `--max-writes-per-run 150` on a schedule (the action's `scope` input, or the dispatch input in the workflow template).

## When a full sweep is owed

The default `corrections` scope visits only PRs showing green, which is sound because a baseline moves forward: a green PR is the only one a move can turn red. It cannot see a PR that is red and should be green. Those all come from an operator action, so the rule is simple: **after any change to a ref under `refs/baselines/` made outside `move-baseline`, and after any change to the `baselines`, `scope` or status-context configuration, run once with `--scope all`.** In detail, `corrections` does not see:

| Change                                                                                                                                                          | Effect on a PR                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A baseline ref deleted or rewound by hand, which is the rollback below                                                                                          | fail to pass, and no move is reported either, so nothing triggers a refresh        |
| A baseline removed from the configuration, or its `scope` narrowed                                                                                              | fail to pass                                                                       |
| The status context renamed                                                                                                                                      | every PR becomes unstamped                                                         |
| The ancestry adapter changing its answer for a scoped baseline (the API compare caps at 300 files and returns nothing, which makes every scoped baseline apply) | fail to pass                                                                       |
| A PR deferred while its head was moving, whose new head carries no status                                                                                       | becomes unstamped; the next push stamps it, or a `--scope unstamped` backfill does |

A forced move, a baseline off the base branch and a custom reporter each force `all` on their own, so no rule is needed for them.

## Adoption at scale

A repository with thousands of open PRs and nothing stamped is decided by **where the baseline is seeded**, not by how fast statuses can be written. A PR with no status is blocked by a required check exactly as a red one is, so leaving PRs unstamped is only safe when they genuinely do need updating:

- **Seeded at the tip of the base branch**, almost no open PR contains it, so nearly every one really is out of date and blocking it is correct. Backfill only adds the explanation.
- **Seeded at the most recent labeled merge**, which is what the tool is for, most open PRs already contain it and are fine. Requiring the check before they are stamped blocks thousands of people who did nothing wrong.

For the second, which is the recommended seed:

1. Seed with `move-baseline --force --to <merge commit of the most recent labeled PR>`.
2. Add the check, but do **not** make it required yet. Nothing is blocked, and PRs stamp themselves as people touch them through the per-PR check.
3. Backfill, throttled: `refresh-pr-statuses --scope unstamped` on a schedule with `--max-writes-per-run 150`. Watch `unstamped` in `report` fall.
4. Make the check required once `unstamped` and `other` are near zero.

**The arithmetic.** GitHub allows roughly 500 content-creating requests an hour, so a full sweep of N open PRs needs about `N / 500` hours at the ceiling, and days at a throttled 150 an hour. Do not run the backfill flat out: at 450 an hour it consumes the repository's entire budget and starves every other workflow that writes a status, a check, a comment or a label. A backfill that stops on its budget having written something is paused, not failed, so it can be scheduled and left alone.

`refresh-pr-status --pr N` stamps one PR on demand, for an author who asks.

**Dependabot.** A run Dependabot triggers gets a read-only workflow token whatever the event, so the per-PR check never stamps its PRs, and the default scope never visits them either. Either configure a custom App or PAT token, which is the fix and needs no standing job, or keep the `--scope unstamped` backfill scheduled permanently. Leaving both undone means every Dependabot PR sits on "Expected" indefinitely: its author cannot push a fix, and no per-PR run will ever write.

**Where the custom token has to live.** GitHub gives a Dependabot-triggered run the repository's **Dependabot** secrets, not its Actions secrets, so a token stored only under Settings, Secrets and variables, Actions is an empty string on exactly the runs that need it, and the step then falls back to the workflow token and writes nothing. Store it under the Dependabot tab as well, or accept the backfill. A GitHub App token minted in the job has the same problem, since the App's private key is itself a secret the run must read.

## Rollback

- **A baseline that left the base branch** (a force push or a hand-edited ref): every PR carries the misconfiguration pass and the sweep fails once, then warns, so nothing is blocked and the schedule does not stay red; repair it with `pr-baseline move-baseline --force --refresh-pr-statuses`, or the dispatch with mode `move-baseline`.
- **A move that should not have happened:** delete the ref (`git push origin :refs/baselines/<name>`, or the refs API), then seed it again at the right commit with `--force --to <sha> --refresh-pr-statuses`. The tool never rewinds a baseline itself, and the forced move that follows refreshes every PR rather than only the green ones. Until the refresh runs, PRs keep the statuses from the wrong move.
- **Stop blocking without removing anything:** make the status context optional in the ruleset. Statuses keep being written and can be required again later.
- **Retire the tool:** remove the context from the ruleset, delete the workflow, delete the refs under `refs/baselines/`. Old statuses stay on their commits and stop mattering.

## What "Expected" means

A required status context that no run has written yet shows as "Expected" and blocks the PR. This happens when the context is required on a branch the tool does not serve, when the refresh never reached a PR, or when the `refresh-pr-status` job did not run for an event. Require the context only in the base branch's ruleset, and dispatch a refresh with `scope: unstamped` to stamp whatever is missing; the default `corrections` scope visits only the PRs that already carry a status.

## Silent schedule loss

GitHub delays or drops scheduled runs under load and disables them in a public repository after 60 days without activity. If the last scheduled run in the Actions list is older than expected, dispatch the workflow by hand and, for a dormant repository, push any commit to re-enable the schedule.
