# @mawesome/pr-baseline-action

## 0.2.1

### Patch Changes

- [#97](https://github.com/mawesomedev/mawesome/pull/97) [`6e9db61`](https://github.com/mawesomedev/mawesome/commit/6e9db615e80520be04628a1d45f9711396d94304) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `pull_request_target` is blocked by default in public repositories from 2 November 2026, which stops the per-PR status unless an Actions event policy allows it. The workflow template now carries a `pull_request` fallback, on which a fork run, whose token a withheld secret leaves empty, skips instead of failing.

## 0.2.0

### Minor Changes

- [#92](https://github.com/mawesomedev/mawesome/pull/92) [`53565d2`](https://github.com/mawesomedev/mawesome/commit/53565d28c8a11d33ba055702e68160081f618fde) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `refresh-pr-statuses` now covers only the PRs a baseline move can have turned red, the ones showing green, with `--scope unstamped` and `--scope all` for the rest. Breaking: `statusMatches` becomes `compareStatus`, a budget stop that made progress is a pause rather than a failure, and several result fields are new or changed meaning.

### Patch Changes

- Updated dependencies [[`53565d2`](https://github.com/mawesomedev/mawesome/commit/53565d28c8a11d33ba055702e68160081f618fde)]:
  - @mawesome/pr-baseline@0.2.0

## 0.1.1

### Patch Changes

- [#88](https://github.com/mawesomedev/mawesome/pull/88) [`14e076b`](https://github.com/mawesomedev/mawesome/commit/14e076b85ec96da2e707c1384e65543bce5ad23d) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Rebuild the action bundle with `undici` 6.28.1, clearing the seven advisories against the bundled 6.26.0.

## 0.1.0

### Minor Changes

- [#79](https://github.com/mawesomedev/mawesome/pull/79) [`2284881`](https://github.com/mawesomedev/mawesome/commit/2284881bf5e6af4aba137415eae960e54ffc1db0) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - New action: keep open pull requests current with a movable baseline ref on the base branch, published to `mawesomedev/pr-baseline-action`.

### Patch Changes

- Updated dependencies [[`2284881`](https://github.com/mawesomedev/mawesome/commit/2284881bf5e6af4aba137415eae960e54ffc1db0)]:
  - @mawesome/pr-baseline@0.1.0
