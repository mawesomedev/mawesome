# @mawesome/pr-baseline

## 0.2.1

### Patch Changes

- [#105](https://github.com/mawesomedev/mawesome/pull/105) [`fc61db6`](https://github.com/mawesomedev/mawesome/commit/fc61db64f8f37eabc0cb9856fbdd376ac727a10e) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Retry a GraphQL response that arrives without data, and report its body if it keeps failing, instead of crashing with `Cannot read properties of undefined (reading 'repository')`.

## 0.2.0

### Minor Changes

- [#92](https://github.com/mawesomedev/mawesome/pull/92) [`53565d2`](https://github.com/mawesomedev/mawesome/commit/53565d28c8a11d33ba055702e68160081f618fde) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `refresh-pr-statuses` now covers only the PRs a baseline move can have turned red, the ones showing green, with `--scope unstamped` and `--scope all` for the rest. Breaking: `statusMatches` becomes `compareStatus`, a budget stop that made progress is a pause rather than a failure, and several result fields are new or changed meaning.

## 0.1.0

### Minor Changes

- [#79](https://github.com/mawesomedev/mawesome/pull/79) [`2284881`](https://github.com/mawesomedev/mawesome/commit/2284881bf5e6af4aba137415eae960e54ffc1db0) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - New package: keep open pull requests current with a movable baseline ref on the base branch, reported through commit statuses via a CLI, a programmatic API and a GitHub Action.
