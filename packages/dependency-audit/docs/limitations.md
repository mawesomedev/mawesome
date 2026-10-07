# Limitations & troubleshooting

The tool aims for **correct, narrow** results: when it reports a finding it is real, and it prefers a notice or an `unchecked` entry over a guess. The trade-off is coverage — these are the known boundaries.

## Known limitations

- **A directory audit reflects the publish set, but only files already on disk.** A directory target is read **in place**, and the scan is restricted to npm's publish set — the `files` allowlist, `.npmignore`, and npm's always-include/exclude defaults (computed via `npm-packlist`) — so references in files npm would exclude (tests, examples, build scripts) are not audited, matching a packed `.tgz`. It does **not** run `prepack`/`prepare` (it never executes your code), so scan the **built** output; a build step that generates files at pack time won't be reflected. The publish set is computed from a lightweight tree rather than a full install, so a package using `bundleDependencies` falls back to scanning every file (as does any case where the set can't be computed). For an exactly-published file set, audit a `.tgz` you packed yourself.
- **`typesVersions` is applied for the current TypeScript version only** — the version running inside the tool — not the full per-consumer-version matrix.
- **The `types-unavailable` / "depend on a version that ships types" refinement keys on whole-package types.** A `missing-types` finding is only refined to a different _kind_ when the package's _bare entry_ resolves to no types; a package that types some subpaths but not its root, or a newer release that adds types only via an implicit `index.d.ts` (no manifest `types`/`exports`), may keep the conservative outcome instead of the sharper hint. Rare, and the failure is conservative (a kept `missing-types`/`types-unavailable`, never a false pass). A **subpath** gap on a package whose bare entry _does_ resolve to types is never reclassified; instead its suggestion is qualified (the `@types/*` companion or typed version may not declare that exact subpath; the fallback is a local ambient `declare module`), since proving a subpath untyped would require materializing and resolving the companion. (A subpath gap on a package with no bare-entry types is still reclassified to `types-unavailable` when no companion exists — the whole package is untyped.)
- **The type surface resolves a single ESM/NodeNext profile.** There is no per-file `require`-context type resolution and no `bundler`-mode type pass; one profile (plus any `--condition`) is checked.
- **The legacy `browser` field remap is not applied** — only the `browser` export **condition** (`--condition browser`). Object/`false`-shim `browser` field rewrites are out of scope.
- **Self-reference (`name`/`name/subpath`) and subpath `#imports` specifiers are skipped** — they are resolved internally by the package, not external dependencies.
- **Dynamic/non-literal specifiers are unchecked, not resolved** — a dynamic `import(variable)`, a templated `require()` call, a `createRequire` result stored in a variable. They appear in `result.unchecked`.
- **The compressed download size of an `http(s)` tarball URL is not separately capped** (the _uncompressed_ extraction is bomb-guarded; registry artifacts are size-bounded by npm). SSRF for caller-supplied URLs is the caller's responsibility. See [Security](./security.md).

## Troubleshooting

### "It reports all clean, but a package I expected wasn't really checked."

Look for an `ℹ` notice on that package. A [`types-not-built`](./findings.md#notices) notice means its type surface was empty because the build output is missing — **build it first**. A `types-ignored-by-exports` notice means its `types`/`typings` field is built but hidden by `exports`. A `types-unreachable` notice means it ships `.d.ts` but no `types`/`exports` condition exposes them. A package that legitimately has no types (a Babel/PostCSS plugin) correctly shows nothing. Use `--require-types` to make missing/unreachable types a hard failure across a monorepo.

### "A finding points at a subpath I'm sure exists."

An `unresolved` runtime finding means the **declared dependency's own `exports`** does not expose that subpath for the call form used (or the target file is absent in the materialized version). Check the dependency's `exports` for that subpath and the version your range resolved to (`resolvedDeps`).

### "A whole target errored (`⚠`)."

The target could not be acquired or parsed: a path that does not exist, a spec that does not resolve on the registry, a network/auth failure, or a corrupt tarball. The error message says which. Other targets in the same run are unaffected. (An error sets exit 2.)

### "A target was skipped (`↷`)."

The path exists but is not an auditable package — a non-tarball file, or a directory without a `package.json` (e.g. a `packages/*` glob matching a `README.md`). Skips are **neutral**: they never raise the exit code, so a stray glob match cannot turn a findings run (exit 1) into an error run (exit 2). Point the tool at built package directories, or use a more specific glob (`packages/*/`) if you would rather not see the skips.

### "`--json > result.json` produced an empty file."

The CLI writes the `--json` array once, after every target finishes, and flushes before exiting (so a redirect/pipe is never truncated). If a stray background error from the registry client surfaces mid-run it is logged to stderr as `warning: ignored a background error — …` and the audit still completes and writes its result — it no longer crashes the whole run. If `result.json` is still empty, the process was killed by something outside the tool's control (out of memory, `ulimit` file-descriptor exhaustion on a very large batch); reduce the number of targets per invocation (e.g. audit in chunks) and check stderr.

### "Running the CLI from inside the package prints 'no such file'."

Invoke the built bin with a path that exists from your current directory — e.g. `node dist/cli.js .` or `./dist/cli.js .` from the package root, not `packages/x/dist/cli.js .` while already inside `packages/x`.

### "A type leaks but `devDependencies` has it — why a finding?"

If a type appears in your **published** `.d.ts`, a consumer must resolve it, so its package must be a non-dev dependency (`dependencies`, or `peerDependencies` for a shared type). A `devDependencies`-only declaration does not reach consumers and is correctly flagged.
