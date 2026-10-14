# @mawesome/dependency-audit

## 0.4.9

### Patch Changes

- [#103](https://github.com/mawesomedev/mawesome/pull/103) [`f99655f`](https://github.com/mawesomedev/mawesome/commit/f99655f8aa3b342031ffc8d42384c84077b67c6c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Report a new `types-ignored-by-exports` notice when a built `types`/`typings` field is hidden by `exports`, instead of the misleading `types-not-built`.

## 0.4.8

### Patch Changes

- [#88](https://github.com/mawesomedev/mawesome/pull/88) [`14e076b`](https://github.com/mawesomedev/mawesome/commit/14e076b85ec96da2e707c1384e65543bce5ad23d) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Raise the `tar` and `pacote` floors to patched releases, clearing their outstanding advisories including a critical one in `tar`.

## 0.4.7

### Patch Changes

- [#87](https://github.com/mawesomedev/mawesome/pull/87) [`4b7e8e3`](https://github.com/mawesomedev/mawesome/commit/4b7e8e3ff4e0315125a359a4dbccf09469ebf8db) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Point the README's docs and playground links at the new `mawesome.dev` domain.

- [#84](https://github.com/mawesomedev/mawesome/pull/84) [`63405e5`](https://github.com/mawesomedev/mawesome/commit/63405e5bdd6e78d7ec914b3b3c4737f436ad96c6) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Point the package's repository, homepage and issue links at the new `mawesomedev` GitHub org.

## 0.4.6

### Patch Changes

- [#74](https://github.com/manzoorwanijk/mawesome/pull/74) [`e8f1fb9`](https://github.com/manzoorwanijk/mawesome/commit/e8f1fb972449c6124db091ed1de1252d7956da04) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Static imports in `.js` ESM bundles are now scanned even when the package has no `"type": "module"`, so their undeclared runtime dependencies are reported.

## 0.4.5

### Patch Changes

- [#64](https://github.com/manzoorwanijk/mawesome/pull/64) [`655dd79`](https://github.com/manzoorwanijk/mawesome/commit/655dd792b99609a6f365df35d070f1a4b685289d) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Document quoting glob targets (e.g. `"./packages/*"`) in scripts so the CLI, not the shell, expands them — keeping the command portable across shells, including Windows.

- [#66](https://github.com/manzoorwanijk/mawesome/pull/66) [`383a0d6`](https://github.com/manzoorwanijk/mawesome/commit/383a0d6229bbc8ba3e69a72c689f02504e8e9610) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Fix an out-of-memory crash when auditing a package whose `node_modules` links into a shared store (e.g. pnpm's or npm with install-strategy=linked).

## 0.4.4

### Patch Changes

- [#61](https://github.com/manzoorwanijk/mawesome/pull/61) [`719b1ec`](https://github.com/manzoorwanijk/mawesome/commit/719b1ecebf16e294cbd6d24520d76aca91bf66be) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Expand glob targets (e.g. `./packages/*`) in the CLI itself, so a pattern works on Windows `cmd.exe` the same as in a POSIX shell.

## 0.4.3

### Patch Changes

- [#59](https://github.com/manzoorwanijk/mawesome/pull/59) [`47f2ded`](https://github.com/manzoorwanijk/mawesome/commit/47f2dedda6e34c5852dd50d102d0eb4766b2e88b) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Print the unused-ignore-rule warning at the very end of the report.

## 0.4.2

### Patch Changes

- [#55](https://github.com/manzoorwanijk/mawesome/pull/55) [`f56e30e`](https://github.com/manzoorwanijk/mawesome/commit/f56e30ec8184366b95236bf28ab4123c59e46bcf) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Report a stale ignore rule as a red `error:` under `--fail-unused-ignores` (where it fails the run) instead of a plain `warning:`, and color stderr diagnostics to match the rest of the output.

## 0.4.1

### Patch Changes

- [#50](https://github.com/manzoorwanijk/mawesome/pull/50) [`7445e49`](https://github.com/manzoorwanijk/mawesome/commit/7445e49a61594be98ae32a5821af07716e4442af) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Emit color under GitHub Actions and recap failing findings above the summary, so CI logs are readable without scrolling.

## 0.4.0

### Minor Changes

- [#48](https://github.com/manzoorwanijk/mawesome/pull/48) [`08feb4a`](https://github.com/manzoorwanijk/mawesome/commit/08feb4aa6b1e713d6989f031da32087e9567826b) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Widen the supported Node range from `>=24.12.0` to `^20.19.0 || >=22.9.0`.

### Patch Changes

- [#46](https://github.com/manzoorwanijk/mawesome/pull/46) [`9f11561`](https://github.com/manzoorwanijk/mawesome/commit/9f11561bdc95f9f552096fbf63e71f1828fe251a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Warn about ignore rules that matched nothing in a run; `--fail-unused-ignores` turns the warning into a failure.

## 0.3.1

### Patch Changes

- [#43](https://github.com/manzoorwanijk/mawesome/pull/43) [`404b9af`](https://github.com/manzoorwanijk/mawesome/commit/404b9af278675aae9b95df7da72a6716b5bb80a5) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Resolve type declarations in the audit's ESM profile mode — the resolver previously probed in CJS mode, falsely flagging dependencies whose types are only reachable via the `import` condition (e.g. an adjacent `.d.ts`) as missing.

- [#45](https://github.com/manzoorwanijk/mawesome/pull/45) [`87f2339`](https://github.com/manzoorwanijk/mawesome/commit/87f233951f32de629dc12e737531a6a9a3667a3c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Undeclared type findings no longer suggest a nonexistent `@types/*` package — when the registry probe reports the companion absent, the advice names only the package itself.

## 0.3.0

### Minor Changes

- [#37](https://github.com/manzoorwanijk/mawesome/pull/37) [`f8f4b97`](https://github.com/manzoorwanijk/mawesome/commit/f8f4b97ae3db86de9929efdcd967f31113b0a5a7) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Add `--collapse-root-cause`: in a multi-target run, a finding whose root cause is another audited target (a producer with a coverage notice) no longer fails the run — it's listed muted and counted as `collapsed`, so you fix the one producer instead of every consumer.

- [#35](https://github.com/manzoorwanijk/mawesome/pull/35) [`9058c6f`](https://github.com/manzoorwanijk/mawesome/commit/9058c6f2f96b60a95bd438a967c4b0306946d2be) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - In a multi-target run, a finding whose package is itself an audited target with a coverage notice is now annotated with `causedBy`, pointing every consumer at the one producer to fix instead of N look-alike findings.

- [#39](https://github.com/manzoorwanijk/mawesome/pull/39) [`550153a`](https://github.com/manzoorwanijk/mawesome/commit/550153a4ce9889a82f847affda85be9979da28c2) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `leakedVia` is now attributed only to a type that appears solely as a synthesized inline `import("x")`, not to a package you import directly — so a genuine direct import is no longer mislabeled as leaked through a dependency.

- [#38](https://github.com/manzoorwanijk/mawesome/pull/38) [`7a860fd`](https://github.com/manzoorwanijk/mawesome/commit/7a860fd970ff954fa4306f2b1026f4a6d4c49630) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - When a package ships no types and has no `@types/*` companion but a published version ships its own types, the finding now names that version ("depend on `x@2.0.0`") instead of the dead-end `types-unavailable`.

- [#34](https://github.com/manzoorwanijk/mawesome/pull/34) [`ad3bbbb`](https://github.com/manzoorwanijk/mawesome/commit/ad3bbbbfaab7895167c10ef96b11c52765e2215b) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - A directory audit now scans only npm's publish set (via `npm-packlist`), so references in files `npm publish` excludes are no longer flagged — matching a packed `.tgz`.

- [#33](https://github.com/manzoorwanijk/mawesome/pull/33) [`979d64e`](https://github.com/manzoorwanijk/mawesome/commit/979d64efcac44708b825a08ef965bd022507a49b) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - A `missing-types` finding is now reported as a distinct `types-unavailable` kind when no `@types/*` companion exists on the registry, instead of suggesting a package that doesn't exist.

- [#31](https://github.com/manzoorwanijk/mawesome/pull/31) [`2b3628a`](https://github.com/manzoorwanijk/mawesome/commit/2b3628a756d688bd425204a2f1dbcec45a59206a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Ignore rules can now be scoped to a `target` (package name or spec) and/or `path` (a `firstSeenIn` glob), so a localized suppression no longer hides the same specifier elsewhere.

- [#36](https://github.com/manzoorwanijk/mawesome/pull/36) [`8f075b9`](https://github.com/manzoorwanijk/mawesome/commit/8f075b938ee6afe6de1b64496c15d834bc9a5e6d) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - An `undeclared` type finding for a type that isn't imported directly but leaks in through a declared dependency's API is now annotated with `leakedVia` (the producer deps), so the suggestion points at the real fix instead of telling you to declare a type you don't use.

- [#32](https://github.com/manzoorwanijk/mawesome/pull/32) [`35463ee`](https://github.com/manzoorwanijk/mawesome/commit/35463ee5be30950cabeda30f20644b91896b54f3) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Runtime `unresolved` findings now carry a `reason` (`subpath-not-exported`, `file-missing`, or `condition-mismatch`) pinpointing the cause, including ESM/CJS export-condition mismatches.

### Patch Changes

- [#41](https://github.com/manzoorwanijk/mawesome/pull/41) [`d769673`](https://github.com/manzoorwanijk/mawesome/commit/d769673608323a5756930b2049cc7ad0f27ddf8d) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - `Finding.causedBy` now carries the producer's `packageName` alongside its `target`, so a JSON consumer can correlate producers by name without parsing the target spec.

- [#30](https://github.com/manzoorwanijk/mawesome/pull/30) [`52d5d4a`](https://github.com/manzoorwanijk/mawesome/commit/52d5d4a1b1c6f9a826138511151139318a2c9081) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Stop masking the decompression-bomb guard for local `file:` tarballs: an oversized/hostile `.tgz` now fails its target instead of being silently treated as an absent dependency.

- [#27](https://github.com/manzoorwanijk/mawesome/pull/27) [`ab1f9ee`](https://github.com/manzoorwanijk/mawesome/commit/ab1f9eeb01cab0705e9f671df78a298d0621091a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Retry transient registry fetches and fail the target if one still can't be fetched, instead of emitting false `undeclared` findings on large batches. Adds `--concurrency` to tune fan-out.

- [#29](https://github.com/manzoorwanijk/mawesome/pull/29) [`aea0899`](https://github.com/manzoorwanijk/mawesome/commit/aea089997249b5c2027e0571af269c27c2fefcb0) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Fix false `unresolved` runtime findings for `npm:` aliased dependencies.

- [#42](https://github.com/manzoorwanijk/mawesome/pull/42) [`b95be85`](https://github.com/manzoorwanijk/mawesome/commit/b95be854a5a9e6350602ba9c804dead752c2f9e0) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - A subpath `missing-types` finding now qualifies its suggestion to note the `@types/*` companion or typed version may not declare that exact subpath, pointing to a local ambient `declare module` as the fallback.

## 0.2.2

### Patch Changes

- [#24](https://github.com/manzoorwanijk/mawesome/pull/24) [`74a3443`](https://github.com/manzoorwanijk/mawesome/commit/74a3443032afa065dfd38cea147050af9274c043) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - The CLI now prints a `dependency-audit vX.Y.Z` banner, and wraps `--json` output in a `{ tool, version, results }` envelope.

- [#22](https://github.com/manzoorwanijk/mawesome/pull/22) [`ca132ef`](https://github.com/manzoorwanijk/mawesome/commit/ca132ef1c55d271b1649208362fcf82de968f33c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Trim the README to a quick start, moving detailed reference into `docs/`, and add npx usage.

## 0.2.1

### Patch Changes

- [#14](https://github.com/manzoorwanijk/mawesome/pull/14) [`46d251e`](https://github.com/manzoorwanijk/mawesome/commit/46d251e5fa85e16b6b7a32d3f9eda80b01ba5f4e) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Link the live in-browser playground from the README.

- [#16](https://github.com/manzoorwanijk/mawesome/pull/16) [`9eab715`](https://github.com/manzoorwanijk/mawesome/commit/9eab715af4175c7387e267d02c46a2e4e7144d7c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Show a live progress indicator on stderr while auditing.

## 0.2.0

### Minor Changes

- [#7](https://github.com/manzoorwanijk/mawesome/pull/7) [`e441ec6`](https://github.com/manzoorwanijk/mawesome/commit/e441ec656c606546f1cc1bec9223eff8496b5c8f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Colorize the default CLI output by severity. Auto-disabled when stdout isn't a TTY (or under `--json`); honors `NO_COLOR` / `FORCE_COLOR`.

### Patch Changes

- [#12](https://github.com/manzoorwanijk/mawesome/pull/12) [`85ca3a8`](https://github.com/manzoorwanijk/mawesome/commit/85ca3a81d8cbfa04a35510041b2b5aaab8fac1d6) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Harden the exit flush so a broken pipe (e.g. `--json | head`) can't crash or hang the process via an `EPIPE`.

- [#8](https://github.com/manzoorwanijk/mawesome/pull/8) [`3f3c858`](https://github.com/manzoorwanijk/mawesome/commit/3f3c8589e674a571eb09534eeaad593df3242c0a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Don't lose `--json` output on a late crash or a truncating pipe: a stray background rejection is logged (not fatal) so the run still writes its result, and exit flushes stdout first.

## 0.1.0

### Minor Changes

- [#2](https://github.com/manzoorwanijk/mawesome/pull/2) [`35b80fb`](https://github.com/manzoorwanijk/mawesome/commit/35b80fba5d669901d53e1d5bedb95c2f56bba72f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Initial release.
