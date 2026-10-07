# Findings & notices

A **finding** is a real problem that fails the audit (`ok: false`, exit 1). A **notice** is a coverage gap that does not fail by default. An **unchecked** specifier is one static analysis could not resolve (surfaced for transparency, never a failure).

## Findings

Every finding has a `surface` (`types` or `runtime`) and a `kind`:

| Kind                | Surface         | Meaning                                                                                                                                                                                                                                                                        |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `undeclared`        | types / runtime | The owning package is reachable on the surface but is **not declared** in any non-dev manifest field.                                                                                                                                                                          |
| `missing-types`     | types           | The package **is declared** but provides **no resolvable declarations** for the specifier (the headline bug — e.g. a `.d.ts` `import('react')` with `react` declared but no `@types/react`).                                                                                   |
| `types-unavailable` | types           | Like `missing-types`, but a registry probe found **no `@types/*` companion exists** — so the gap is **not fixable by declaring a dependency**. A distinct kind so a CI gate can treat a genuinely-unfixable gap differently (e.g. suppress `{ "kind": "types-unavailable" }`). |
| `unresolved`        | runtime         | The package **is declared** but the specifier does **not resolve to a file** — typically a deep import of a subpath the dependency's `exports` does not expose, or a missing target file.                                                                                      |

An `unresolved` finding also carries an optional **`reason`** naming the specific cause, so the diagnosis isn't a guess:

| `reason`               | Meaning                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `subpath-not-exported` | The package's `exports` map does not expose this subpath.                                                                    |
| `file-missing`         | The specifier maps to a target file that is not present.                                                                     |
| `condition-mismatch`   | It resolves under the **other** call form — a `require` (CJS) of an `import`-only `exports`, or vice-versa (ESM/CJS hazard). |

`reason` is omitted when the cause is indeterminate (e.g. the package is not in the resolution tree). Each finding also carries a `suggestion` with concrete remediation. Examples:

```
✗ types      [undeclared]     csstype  (dist/index.d.ts)
    → declare "csstype" (or "@types/csstype" if it ships no types)

✗ types      [missing-types]  react  (dist/index.d.ts)
    → "react" is declared but provides no resolvable declarations for "react"; add "@types/react" or a version that ships types

✗ runtime    [unresolved]     @wordpress/boot  (build/index.cjs)
    → "@wordpress/boot" resolves for import (ESM) but was loaded via require (CJS) — "@wordpress/boot" exposes no "require" export condition (ESM/CJS mismatch)
```

### How to fix each

- **`undeclared` (runtime):** add the package to `dependencies` (or `peerDependencies`/`optionalDependencies` if that fits its role).
- **`undeclared` (types):** add the package — or its `@types/*` companion if it ships no types of its own — to a **non-dev** field. `devDependencies` is **not** enough when the type appears in your published `.d.ts`, because a consumer must resolve it. But first check **`leakedVia`** (below) — if the type entered through a dependency's API rather than your own import, the durable fix is in that producer.
- **`missing-types`:** declare the `@types/*` package, or upgrade the dependency to a version that bundles its own declarations. When the gap is a **subpath** (e.g. `x/deep`), the suggestion adds a caveat — the companion or typed version may not declare that exact subpath even when it covers the package root, in which case the only fix is a local ambient `declare module "x/deep"`.
- **`types-unavailable`:** there is no `@types/*` to declare — the only fixes are upstream (ship types from the package itself) or local (add an ambient `declare module "x"` in your own sources). Treat it as a known gap rather than a missing declaration; suppress with an ignore rule on `{ "kind": "types-unavailable" }` if you've accepted it.
- **`unresolved`:** let the `reason` guide the fix. `subpath-not-exported` → stop importing the private subpath, or ask the dependency to add it to its `exports`. `condition-mismatch` → the dependency is missing the `require`/`import` export condition you load it under (a real dual-package bug — fix the producer, or load it under the other form). `file-missing` → the mapped target isn't shipped (build/packaging gap). If it is your own subpath that the dependency genuinely exports, it can also indicate a version mismatch in the materialized tree.

The `missing-types` → `types-unavailable` distinction needs a registry lookup for the `@types/*` companion. When the audit can't reach the registry (offline, or a provider without the probe capability — the browser build has no network), it conservatively keeps `missing-types` rather than guessing the companion is absent. When no `@types/*` exists **but a published version of the package ships its own types**, the finding stays a (fixable) `missing-types` and the suggestion names that version (_"`x@2.0.0` ships its own types — depend on that version"_) instead of the dead-end `types-unavailable`.

### Leaked types (`leakedVia`)

A package's emitted `.d.ts` often references a type it never imports: TypeScript **inlines** `import("x")` into your declarations when a **declared dependency**'s public API returns/accepts/re-exports a type from `x` (the classic `.d.ts` portability trap). The naive advice — "declare `x`" — is misleading, because you don't use `x` directly; the real fix belongs to the dependency.

An `undeclared` type finding is attributed only when the package appeared **solely** as a synthesized inline `import("x")` — never as an author-written top-level `import`/`export` or `/// <reference>`. That's the leak signature: tsc inlines `import("x")` precisely because your code didn't import `x` itself. A package you do import directly is a genuine direct use and is left as a plain `undeclared` finding (declare it). When such an inline-only package also appears in a declared dependency's own public type surface, the tool records that dependency in **`leakedVia`** and rewrites the suggestion to _"`x` is also exposed by declared dependency `B` … the durable fix is in `B`, otherwise declare `x` yourself."_ All exposing deps are listed; if none expose it, it stays a plain finding. (Detected by re-scanning each declared dependency's type surface — no type-checker — so it works wherever the audit runs. A hand-written inline `import("x")` in your own source is indistinguishable from a synthesized one in the emitted `.d.ts`, so the suggestion is hedged accordingly — "if you don't import it directly".)

### Node builtins

A `node:`-prefixed or bare builtin (`fs`, `path`, …) needs **no** declaration at run time, so it is never a runtime finding. On the **type** surface a builtin implies `@types/node`: if a declaration references a builtin and `@types/node` is not declared, that is an `undeclared` finding suggesting `@types/node`.

## Notices

A notice means a surface had **nothing to analyze** — emitted so "audited, clean" is never confused with "nothing audited". Notices live in `result.notices`, print as `ℹ`, and do **not** fail the audit unless you pass `--require-types`.

| Kind                       | Surface | Meaning                                                                                                                                                                                                                                                                     |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types-not-built`          | types   | The manifest **declares** type declarations (a `types`/`typings` field, `typesVersions`, or an `exports` `types` condition) but **none resolve** from the package root — the build output looks missing. Build the package before auditing, or fix the declared types path. |
| `types-ignored-by-exports` | types   | A `types`/`typings` field **resolves to built declarations**, but the package has an `exports` map, so TypeScript ignores that field and finds no types through `exports`. Add a `types` condition to `exports`, or ship a `.d.ts` next to each exported `.js`.             |
| `types-unreachable`        | types   | The package **ships `.d.ts` files** but **no manifest entry exposes them** (no `types` field, no `exports` `types` condition, and `exports` encapsulates the package). Consumers cannot resolve its types — a likely packaging gap.                                         |

A package that legitimately declares and ships no types (e.g. a Babel/PostCSS plugin) produces **no** notice. A fully-analyzed type surface produces no notice.

### `--require-types`

Pass `--require-types` (CLI) to promote any coverage notice to a failure (exit 1) — useful in a monorepo gate where every TypeScript package is expected to ship resolvable types. Programmatically, inspect `result.notices.length` yourself.

### Cross-target correlation (`causedBy`)

When you audit many packages at once and one of them (a **producer**) carries a coverage notice — its types aren't built or reachable — every consumer of it gets the same `missing-types` (or `types-unavailable`) finding. In that run the tool annotates each such consumer finding with **`causedBy`** (the producer's target, package name, and notice kind), printed as a `↳ caused by <producer-target> …` line, so all the look-alike findings point at the **one producer to fix** rather than reading as N separate problems. An `undeclared` finding is never annotated — that's a consumer-side gap, not the producer's fault. By default it's purely informational — nothing is suppressed and the exit code is unchanged — and it only correlates within a single run.

Pass **`--collapse-root-cause`** to act on the annotation: a `causedBy` finding then no longer fails the run (you're expected to fix the producer, whose own notice you can gate with `--require-types`). Such findings are still listed — muted, as `↳ … — root cause: <producer> (<notice>)` — and counted separately as `collapsed`, so nothing is hidden. (`--json` is unchanged: `causedBy` is always present; the `result.ok` field still reflects all findings, so a JSON consumer applies its own collapse policy.)

## Unchecked specifiers

A specifier whose value is not a literal — a dynamic `import(someVariable)`, a templated `require()` call, a `createRequire` result stored in a variable — cannot be statically resolved. Rather than drop it (a silent false negative), the tool records it in `result.unchecked` with a `reason`, printed as `?`. Review these manually; they are not failures.

## Ignoring intentional findings

Some findings are intentional — an optional/plugin import the code guards at run time, or a specifier static analysis cannot prove is fine. Suppress them with ignore rules (CLI `--ignore`, or a [config file](./cli.md#config-file)). Suppressed findings move to `result.ignored`, still print (`— ignored`), and never fail the audit — so suppressions stay auditable. A rule that matches nothing across a whole run is warned as stale, and `--fail-unused-ignores` makes that a failure (see [Stale ignore rules](./cli.md#stale-ignore-rules)).

An **IgnoreRule** matches a finding when **every** field it sets equals the finding's; an empty rule matches nothing:

```jsonc
{ "package": "optional-plugin" }                          // any finding for this package
{ "specifier": "react/jsx-runtime", "surface": "types" }  // this exact specifier, on the type surface
{ "surface": "runtime", "kind": "unresolved" }            // all unresolved runtime findings
```

`package`/`specifier`/`surface`/`kind` match the finding itself. Two optional fields **scope** a rule, so a localized suppression can't also hide a real regression of the same specifier in another package:

- **`target`** — restricts the rule to one audited target. It matches that target's package **name** (most reliable — e.g. `my-pkg`) **or** the target string **exactly as passed** to the audit (a directory, `.tgz` path, or spec). The spec form is not path-normalized, so prefer the package name when you can.
- **`path`** — a glob over the finding's package-relative `firstSeenIn`. A `path` rule alone applies in **every** target (it scopes by location, not by package); combine it with `target` to scope to one package's files.

Glob syntax (the common gitignore subset): `*` matches within a single path segment, `?` matches one non-`/` character, and `**` is a globstar only as a whole segment — a leading/inner `**/` matches zero or more segments (`**/x` matches `x` and `a/b/x`), and a trailing `/**` matches all descendants (`fixtures/**` matches `fixtures/x` but not `fixtures` itself).

```jsonc
{ "target": "my-pkg", "path": "fixtures/**", "specifier": "x" } // only in my-pkg's fixtures
```

A CLI `--ignore <value>` is shorthand for "match `package === value` OR `specifier === value`" (an unscoped, global rule); use a config file for `target`/`path` scoping.
