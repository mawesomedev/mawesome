# CLI reference

```sh
dependency-audit [options] <target...>
```

A **target** is one of:

- a **package directory** containing `package.json` (read in place — build it first);
- a local **`.tgz`** / **`.tar.gz`** tarball (extracted to a temp dir);
- a **published spec** — `name`, `name@version`, `name@tag`, `@scope/name`, `@scope/name@version`;
- an **`http(s)` tarball URL** (fetched via npm's cache/auth, integrity-verified).

Multiple targets may be passed; each is audited independently and isolated — one target failing to acquire/audit reports as an error for that target and never discards the others.

A path-shaped glob (e.g. `./packages/*`, `../../packages/*`) is expanded by the CLI itself, so it behaves the same on Windows — where `cmd.exe`/PowerShell don't expand globs — as in a POSIX shell. **Quote the pattern** (`"./packages/*"`) in a script so a POSIX shell doesn't expand it first; then the CLI does the expansion identically on every OS (the result is the same either way, but quoting keeps the command portable). The base may use `.`, `..`, or be absolute. A pattern matching nothing is kept as-is, surfacing as a clear "not found" error, and a published spec or URL is never globbed, so `lodash@*` still resolves against the registry.

A local path that **exists but is not an auditable package** — a non-tarball file, or a directory without a `package.json` — is **skipped** (a neutral `↷` notice), not treated as an error. This is what keeps a stray glob match (`packages/*` catching a `README.md`) from turning a findings run (exit 1) into an error run (exit 2). A path that does **not** exist, or a spec that fails to resolve, is still a hard error.

## Options

| Option                  | Argument          | Description                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--ignore <value>`      | package/specifier | Suppress findings whose **package** OR exact **specifier** equals `<value>`. Repeatable. Suppressed findings are still listed (`— ignored`) and never fail the audit.                                                                                                    |
| `--config <path>`       | path              | Load ignore rules from a JSON config. Defaults to `./dependency-audit.config.json` if present.                                                                                                                                                                           |
| `--fail-unused-ignores` | —                 | Fail (exit 1) when an ignore rule (config or `--ignore`) matched nothing in this run. Stale rules are otherwise only warned on stderr.                                                                                                                                   |
| `--condition <name>`    | condition name    | Activate an extra `exports` resolution condition (e.g. `browser`) for entry discovery **and** resolution. Repeatable.                                                                                                                                                    |
| `--concurrency <n>`     | positive integer  | Cap how many targets — and how many dependencies per target — materialize at once (default: 6 targets × 12 deps). Lower it to ease load on a large batch; `--concurrency 1` runs fully serially. Also via `DEPENDENCY_AUDIT_CONCURRENCY`.                                |
| `--require-types`       | —                 | Treat a coverage notice (missing, hidden or unreachable type surface) as a failure (exit 1) rather than just a notice.                                                                                                                                                   |
| `--collapse-root-cause` | —                 | In a multi-target run, don't fail on a finding whose root cause is another audited target (its types aren't built/reachable) — fix that producer instead. Such findings are still listed, muted (`↳ … — root cause: <producer> (<notice>)`), and counted as `collapsed`. |
| `--json`                | —                 | Emit machine-readable JSON: a `{ tool, version, results }` envelope, one `results` entry per target. See [Output format](./output-format.md).                                                                                                                            |
| `--no-progress`         | —                 | Suppress the stderr version banner and progress spinner even on a terminal. Also honored via the `NO_PROGRESS` env var.                                                                                                                                                  |
| `-v`, `--version`       | —                 | Print the version and exit.                                                                                                                                                                                                                                              |
| `-h`, `--help`          | —                 | Print usage and exit.                                                                                                                                                                                                                                                    |

## Exit codes

| Code | Meaning                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Clean — no findings (and, under `--require-types`, no coverage notices).                                                                                          |
| `1`  | At least one finding (or, under `--require-types`, at least one coverage notice). Under `--collapse-root-cause`, a finding collapsed to a producer doesn't count. |
| `2`  | At least one target could not be audited at all (acquisition/fetch/parse error). Takes priority.                                                                  |

When multiple targets are audited, the **highest** applicable exit code wins: any error → `2`; else any finding → `1`; else `0`. **Skipped** targets (non-package paths) are neutral — they never raise the exit code.

### Stale ignore rules

An ignore rule that matched nothing across the whole run is reported on stderr (`unused ignore rule — … matched nothing in this run`), so a rule outlives the gap it suppressed for no longer than one run. It is a non-fatal `warning:` by default; under `--fail-unused-ignores` it both escalates to exit `1` and is labelled `error:` to match. A `--ignore <value>` flag counts as used when **either** of its package/specifier forms matched; staleness is judged run-wide, so a `target`-scoped config rule is not warned just because some targets didn't need it. The reports are suppressed when any target **errored** (the failed audit might have contained the match). Programmatic consumers get the same signal per target via `AuditResult.usedIgnoreRules`.

## Examples

```sh
# A built package directory
dependency-audit ./packages/my-lib

# A packed tarball
dependency-audit ./my-lib-1.2.3.tgz

# Straight from npm
dependency-audit lodash@4.17.21
dependency-audit @sindresorhus/is@latest

# A whole monorepo's built packages, machine-readable, for CI
dependency-audit --json "./packages/*"

# Audit the browser export condition instead of the default Node profile
dependency-audit --condition browser ./packages/my-lib

# Treat "types not built / unreachable" as a hard failure
dependency-audit --require-types "./packages/*"

# Don't let an internal producer's type gap fail every consumer — fix the producer
dependency-audit --collapse-root-cause "./packages/*"

# Suppress a known-intentional optional import
dependency-audit --ignore optional-plugin --ignore react/jsx-runtime ./packages/my-lib
```

## Config file

A JSON config supplies ignore rules (see [Findings & notices → ignoring](./findings.md#ignoring-intentional-findings)). By default `./dependency-audit.config.json` is read if present; `--config <path>` overrides the location.

```json
{
	"ignore": [
		{ "package": "optional-plugin" },
		{ "specifier": "react/jsx-runtime", "surface": "types" },
		{ "surface": "runtime", "kind": "unresolved" },
		{ "target": "my-pkg", "path": "fixtures/**", "specifier": "x" }
	]
}
```

A rule matches a finding when **every** field it sets equals the finding's; an empty rule matches nothing. Two optional fields **scope** a rule: `target` (audited package name or target spec) restricts it to one audited package, while `path` (a `**`/`*`/`?` glob over the finding's `firstSeenIn`) scopes by location and still applies in **every** target — combine them to confine a rule to one package's files. CLI `--ignore` rules (always global) are merged with config rules. See [Findings → ignoring](./findings.md#ignoring-intentional-findings) for the full glob semantics.

## Monorepo usage

The CLI does not know about your repo layout — point it at the **built** package directories. For a pnpm/npm/yarn workspace:

```sh
pnpm -r exec dependency-audit .      # one process per package (simple, fully isolated)
dependency-audit "./packages/*"        # one process, bounded-concurrency, isolated per target
```

Quote the glob (`"./packages/*"`) so the CLI expands it rather than the shell — the same command then works everywhere, including Windows `cmd.exe`/PowerShell, which don't expand globs.

Local `@scope/*` dependencies declared as `file:`/`workspace:`/`link:` are resolved by linking the already-built sibling, so you do not need to publish or rebuild siblings first — just build them.

A transient registry fetch under heavy concurrency is retried with backoff (`DEPENDENCY_AUDIT_RETRIES`, default 3); if a dependency still cannot be fetched, that **target** fails with an error (exit `2`) rather than reporting its imports as undeclared — so a network blip never produces a false finding. Lower `--concurrency` on a very large batch to reduce the load that triggers those retries.
