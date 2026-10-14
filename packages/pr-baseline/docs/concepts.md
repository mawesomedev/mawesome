# Concepts

## The baseline

A **baseline** is a git ref on the base branch that marks the last commit every open pull request must contain. It lives under its own namespace, `refs/baselines/<name>` (`refs/baselines/pr-baseline` by default), and moves forward only, and only by intent:

- a `move-baseline --force` (a workflow dispatch, in the action),
- a merged pull request carrying the baseline's **label**,
- a push to the base branch touching one of the baseline's **markers** (gitignore-style path patterns).

The namespace is deliberate; see [why not a tag](#why-not-a-tag-or-a-branch) below.

The tool never rewinds a baseline: it checks that the target descends from the current commit before every move, and a rewind is an operator action (delete the ref, seed it again). GitHub itself enforces a fast-forward only for branches, and no API offers a conditional write for the namespace, so the move is a `git push --force-with-lease` on the commit the run read, a compare-and-swap the server honours for every ref. The run tries, in order: the clone, when git ancestry is in use; an empty repository the tool creates in a temporary directory, fetches the target commit into treelessly and deletes afterwards; and last the refs API, reached only when both git ways failed for a reason other than a lost lease, when there is no git, or with `--ancestry api`. The push updates the one leased ref and nothing else: hooks, signing, tag following, submodule recursion and push options are all switched off, whatever the clone's configuration says. That path re-reads after every write and re-applies its move once when another writer crossed it, but a forward move that lands just before its write is rewound, which the run cannot see. See [edge cases](./edge-cases.md) for the concurrency rules.

## Why not a tag, or a branch

A tag is the obvious ref for "this commit", and it is the wrong one for a ref that moves. Clones follow tags automatically, and git refuses to update a tag it already has: once the baseline has moved, every developer's next `git pull` or `git fetch` fails with `! [rejected] pr-baseline -> pr-baseline (would clobber existing tag)`, and keeps failing until they run `git fetch --tags --force` or delete the tag by hand. Editors and tools that fetch in the background hit the same wall, so one move a week turns into a repository-wide interruption. On the server side a tag also fires `push` events and lands in every "tags" listing, and its moves show up as noise in release tooling.

A branch is worse in different ways: a `refs/heads/` ref triggers workflows on every move, shows a "Compare & pull request" prompt to whoever pushed it, and is the first thing branch-cleanup tooling and "delete merged branches" habits remove.

`refs/baselines/<name>` has none of that. Nothing fetches the namespace unless asked to, so a move is invisible to clones and costs developers nothing; it starts no workflow, and no cleanup tool knows it exists. The price is that the ref has no page in the GitHub UI: `pr-baseline report` and `git ls-remote origin 'refs/baselines/*'` show it, the failing status names the baselines a PR lacks, and its default link opens the compare view of what the PR is missing. The [permissions](./permissions.md) page covers the other consequence, that no ruleset can guard the namespace.

## Verdicts

For a commit, the verdict is `pass` when every applicable baseline is an ancestor of it and `fail` otherwise. An absent baseline counts as satisfied, so a repository can adopt the tool before seeding anything. One commit status carries the combined verdict; the failing description names the missing baselines.

Two other passes exist: **not applicable**, written only with `--other-bases pass` for a PR targeting another branch, and **misconfigured**, written by `refresh-pr-status` when a baseline is no longer on the base branch, so an operator mistake never blocks an author. `refresh-pr-statuses` writes that same pass to every open PR, which is why an off-base baseline forces the full sweep whatever scope was asked for, and the action fails the step while that is news, then only warns once every PR already carries the message, so the open gate is seen without a red run every hour; `report` prints the problem and exits 2. A forced move onto a commit on the base branch repairs it.

## Scope

Only PRs that land on the configured branch are evaluated and stamped: those whose base is that branch, and every PR of a GitHub stack whose base is that branch. A commit status belongs to a SHA and a context, not to a PR, so writing a verdict for an out-of-scope PR could leak onto an in-scope one sharing the same head. Read [edge cases](./edge-cases.md) before switching `--other-bases` to `pass`.

## Several baselines

A repository may define several baselines, each `{ name, label?, scope?, markers? }`:

- `scope` decides which PRs the baseline binds: those whose diff against the base branch touches a scope pattern. Absent means every PR.
- `markers` decides when a base push moves the baseline automatically. Absent means only its label and a forced move do.
- `label` names the label whose merged PRs move the baseline. Several baselines may share one label.

The two are independent: a repository-wide baseline can move only when `.nvmrc` changes, and a per-package baseline can bind only that package's PRs while moving on its own toolchain files. Both use gitignore grammar through the `ignore` package, applied to changed filenames, so git and API decisions cannot diverge.

## Idempotency

A refresh recomputes the verdict of the PRs its scope selects, by default the ones showing green, and writes only when the existing status differs in state, description, target URL or creator. A difference in description or link alone is cosmetic and costs no write outside the full sweep. The description is human text and encodes no SHA. Without a configured target URL a failing status links to the compare view `<head>...<base branch>` on the server, which names the branch rather than the baseline commit, so a move alone never changes it. A status written by another creator (an old token, a previous integration) is rewritten, so a ruleset pinned to a source is always satisfied by the configured token.

## Recovery

A refresh that hits a rate limit or a write budget having written something, with nothing failed and nothing deferred, is paused rather than failed: it exits 0 with a summary, and the next run at the same scope continues where it left off, since every write it made is already current. One that stops having written nothing, or with any failure, exits nonzero with a retry hint. Scheduled runs are best effort on GitHub, so a workflow dispatch is the immediate retry and `report` tells an operator whether anything is still stale.

## Ancestry sources

Two adapters answer "does this commit contain that one": the **API** adapter through the compare endpoint, one request per question, and the **git** adapter through `git merge-base --is-ancestor` in a local clone, which costs no API quota. A treeless clone (`git clone --filter=tree:0`) with full history is enough: ancestry needs only commits, and the few trees a path diff needs are fetched lazily. A shallow clone is never used, because it can hold both commits of a question and still answer it wrong; in GitHub Actions that means `fetch-depth: 0`. Git 2.45 or newer is required, so presence probes never turn into one-commit-at-a-time lazy fetches. With a token the API stays authoritative for the baseline refs; the git adapter reads what the remote advertises for each of them (`ls-remote`, peeled to the commit) and refuses to continue when that disagrees with the API, which means the baseline moved during the run; only missing commits are fetched, by SHA, and the adapter writes no refs of its own. Before a refresh the git adapter fetches the selected PR heads in a few batches and lists the open PRs again, so a PR that closed, left the base branch, or moved since the first listing is counted as `closed`, `out-of-scope` or `deferred`, or evaluated at its stable new head, instead of being stamped at a stale one. The adapter runs git with a clean environment (no inherited `GIT_*` variable), with hooks, credential helpers, replacement objects and submodule recursion disabled with the token present only as an authorization entry scoped to the configured server's origin, limits git to the one transport the validated remote uses (online only https or a local path; an ssh clone is used offline only), and refuses a clone with grafts, with a URL rewrite rule, with clone-local settings that could steer or observe a fetch (`http.*` other than an origin-scoped persisted header, proxies, ssh or credential settings, programs git would run), or with any promisor identity other than the validated remote (git records the fetched URL itself as one). When `auto` chose git and preparing the clone then fails on a git error, the rest of the run uses the API adapter; a failure after preparation, such as a lazy tree fetch during a diff, still fails the run.

Offline, `refresh-pr-status --offline` reads the baseline refs from the clone itself, which a plain clone does not have: fetch them first with `git fetch origin '+refs/baselines/*:refs/baselines/*'`.
