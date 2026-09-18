# For PR authors: the "PR baseline" status

Your pull request shows a failing **PR baseline** status because a change landed on the base branch that every open PR must include before it merges, such as a toolchain bump or a CI fix. Nothing is wrong with your code. Bring the base branch into your PR and the status turns green on the next push:

```sh
git fetch origin
git merge origin/main      # or: git rebase origin/main
git push
```

By default the status's **Details** link opens a compare view of the commits the base branch has that your branch lacks; a repository may point it elsewhere, such as this page. Replace `main` with your repository's base branch. If the status names several missing baselines, one merge or rebase satisfies all of them. If the status still fails after pushing, ask a maintainer to run the refresh. Some repositories cannot stamp a PR the moment you push, in which case the status stays behind until a maintainer, or the schedule, runs a refresh that covers it: that is the case for a PR from a fork, and for a PR carrying a merge conflict, where the repository does not use the `pull_request_target` trigger.
