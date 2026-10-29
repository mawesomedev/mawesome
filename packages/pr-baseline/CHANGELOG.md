# @mawesome/pr-baseline

## 0.4.0

### Minor Changes

- [#120](https://github.com/mawesomedev/mawesome/pull/120) [`c607948`](https://github.com/mawesomedev/mawesome/commit/c60794809ae32bd78608ea8689697b92619a6fe8) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - A refresh evaluates a PR at the head the API reports when its pull ref lags behind, instead of deferring it and failing the run.

## 0.3.0

### Minor Changes

- [#108](https://github.com/mawesomedev/mawesome/pull/108) [`ed7ffcf`](https://github.com/mawesomedev/mawesome/commit/ed7ffcfa2814e21d6c3e020c0eebde7360bb9aaf) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Judge every PR in a GitHub stack against the branch the stack lands on, so stacked PRs get the status their required check waits for.

### Patch Changes

- [#105](https://github.com/mawesomedev/mawesome/pull/105) [`fc61db6`](https://github.com/mawesomedev/mawesome/commit/fc61db64f8f37eabc0cb9856fbdd376ac727a10e) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Retry a GraphQL response that arrives without data, and report its body if it keeps failing, instead of crashing with `Cannot read properties of undefined (reading 'repository')`.

## 0.2.0

### Minor Changes

- [#92](https://github.com/mawesomedev/mawesome/pull/92) [`53565d2`](https://github.com/mawesomedev/mawesome/commit/53565d28c8a11d33ba055702e68160081f618fde) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `refresh-pr-statuses` now covers only the PRs a baseline move can have turned red, the ones showing green, with `--scope unstamped` and `--scope all` for the rest. Breaking: `statusMatches` becomes `compareStatus`, a budget stop that made progress is a pause rather than a failure, and several result fields are new or changed meaning.

## 0.1.0

### Minor Changes

- [#79](https://github.com/mawesomedev/mawesome/pull/79) [`2284881`](https://github.com/mawesomedev/mawesome/commit/2284881bf5e6af4aba137415eae960e54ffc1db0) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - New package: keep open pull requests current with a movable baseline ref on the base branch, reported through commit statuses via a CLI, a programmatic API and a GitHub Action.
