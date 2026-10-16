# AGENTS.md

Canonical instructions for humans and AI agents working in this monorepo. This is the authoritative source for commands and rules; `CONTRIBUTING.md` and `README.md` point here.

## What this is

A pnpm monorepo that publishes packages under the `@mawesome/*` scope. The repository is designed to double as a **template** for new monorepos, so keep the foundation decoupled from any individual package.

## Toolchain

| Concern         | Tool                                                               |
| --------------- | ------------------------------------------------------------------ |
| Package manager | **pnpm 10** (Node `>=24.12`, see Provisioning)                     |
| Lint            | **oxlint** (oxc)                                                   |
| Format          | **oxfmt** (oxc) — the single source of truth for formatting        |
| Dependencies    | **syncpack** — one version per dependency + `workspace:*` protocol |
| Type-check      | **tsgo** (`@typescript/native-preview`) — fast native checker      |
| Bundle (pkgs)   | **tsdown** (rolldown + oxc) — dual ESM/CJS + `.d.ts`               |
| Test            | **vitest**                                                         |
| Publish hygiene | **@arethetypeswrong/cli (attw)** + **publint**                     |
| Releases        | **changesets** + GitHub Actions, npm OIDC trusted publishing       |

Repo-level CLIs (oxlint, oxfmt, syncpack, tsgo) and their typed configs live in the private `tools/repo` workspace; the shared TypeScript base lives in `tools/tsconfig` (`@mawesome/tsconfig`).

## Commands (run from the repo root)

| Command                | What it does                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install`         | Install (honors the 3-day `minimumReleaseAge` cooldown)                                                                  |
| `pnpm verify`          | Full gate: lint → format:check → deps:lint → check:root-deps → build:packages → typecheck → test → build → check:exports |
| `pnpm lint`            | oxlint (`pnpm lint:fix` to autofix)                                                                                      |
| `pnpm format`          | oxfmt write (`pnpm format:check` to verify only)                                                                         |
| `pnpm deps:lint`       | syncpack version/protocol checks (`pnpm deps:fix` to fix)                                                                |
| `pnpm check:root-deps` | Enforce the root dependency allowlist                                                                                    |
| `pnpm typecheck`       | tsgo per workspace                                                                                                       |
| `pnpm test`            | vitest per workspace                                                                                                     |
| `pnpm build`           | Build every workspace (packages via tsdown; apps via their own build)                                                    |
| `pnpm build:packages`  | Build only the publishable packages — used by the release publish step (apps don't publish)                              |
| `pnpm check:exports`   | attw + publint per package                                                                                               |
| `pnpm changeset`       | Create a changeset (see CONTRIBUTING for the release flow)                                                               |
| `pnpm audit`           | `pnpm audit --audit-level=high`                                                                                          |

## Hard rules (do / don't)

- **Never add dependencies to the root `package.json`.** Declare them in the owning package, or in a `tools/*` workspace for repo-level tooling. The **only** allowed root `devDependencies` are the `@changesets/*` allowlist; `pnpm check:root-deps` fails CI on anything else. Changing the allowlist requires updating both `tools/repo/scripts/check-root-deps.ts` and this rule.
- **Never re-enable hoisting** (`hoist` / `publicHoistPattern` / `shamefullyHoist`) to "fix" a missing dependency. Add the real declaration instead.
- **Never add an `allowBuilds: { <pkg>: true }` entry** (or set `dangerouslyAllowAllBuilds`) without explicit review. Dependency build scripts are blocked by default (`strictDepBuilds`); `allowBuilds` is the pnpm ≥10.26 map that replaces `onlyBuiltDependencies`/`ignoredBuiltDependencies`.
- **Add dependencies with `pnpm add`, never by hand-editing `package.json`.** Scope it to the owning workspace (`pnpm --filter <pkg> add <dep>`, or run from the package dir) so pnpm resolves the version, writes the range, and updates the lockfile in one consistent step. Pin an explicit range (`pnpm add <dep>@^x.y.z`) when you need a non-latest version. Hand-editing risks a lockfile that drifts from the manifest.
- **Every dependency uses a single caret range, identical across the repo** — syncpack enforces one version per dependency (`pnpm deps:lint`/`deps:fix`); internal `@mawesome/*` deps use **`workspace:*`**. New versions must already satisfy the 3-day `minimumReleaseAge`. (Exception: `@typescript/native-preview` is a fast-moving preview, so it's pinned to an **exact** build and bumped deliberately.)
- **Config-file format preference: `.ts` → `.mjs` → JSON/YAML.** Prefer a typed `.ts` config (oxlint, oxfmt, tsdown, vitest, syncpack); drop to `.mjs`, then JSON/YAML, only when the tool supports nothing better (changesets → JSON, `tsconfig.json`, `pnpm-workspace.yaml`). A `.ts` tool-config that imports the tool lives in the workspace that declares it (`tools/repo`).
- **In-house monorepo scripts: author in `.ts`, run with plain `node script.ts`.** Node `>=24.12` strips types natively — no tsx/ts-node/tsdown for internal scripts. Use erasable syntax only (`erasableSyntaxOnly` enforces this); tsdown is only for _published_ packages. Parse CLI args with `node:util` `parseArgs`; detect direct execution with `import.meta.main`.
- **Reusability first (when earned).** When functionality is likely to be reused and its API has stabilized, extract it into its own published `@mawesome/*` package — but first search npm for an existing, well-maintained package and prefer reusing it over reinventing. Don't prematurely extract a weak API.
- **Every change to a published package needs a `pnpm changeset`.** Keep the changeset summary (the changelog entry) **short and precise** — one or two sentences on what changed and why it matters to a consumer; no implementation detail or fluff.
- **Don't write a novel in a changelog.** A changeset summary is **at most two short sentences** — ideally one. State the consumer-visible change and stop; no run-on sentences, no parenthetical asides, no listing every flag/edge case. If it reads like release notes, cut it down.

## Coding guidelines (humans and agents)

- Keep code comments **brief, precise, and to the point** — only the essential detail needed to understand the code; no verbosity or tangents.
- Write **one sentence per line** in comments — never wrap a single sentence across lines (keeps comments friendly to screen readers and assistive tech).
- When a comment spans **more than one line, use a single block comment** (`/* … */` or `/** … */`) rather than stacking `//` lines; reserve `//` for genuine one-liners. Don't churn existing comment styles.
- Markdown prose is **soft-wrapped**: one line per paragraph, no hard wrapping — let the editor wrap. (Lists, tables, and code fences keep their structure; this is distinct from the one-sentence-per-line rule for code comments.)
- oxlint/oxfmt enforce the mechanical rules; these guidelines cover what tools can't.

## Adding a package

Use `/add-package <name>` (or copy `templates/package/`) — see CONTRIBUTING.md. A new package extends `@mawesome/tsconfig`, builds with tsdown (dual ESM/CJS + `.d.ts`), declares all of its own dependencies (matching the repo-wide version), and ships a `check:exports` gate.

## Provisioning

CI installs pnpm with `pnpm/action-setup` (it reads the range from `devEngines.packageManager`). Locally, install pnpm standalone (`npm i -g pnpm@10`, the pnpm install script, or a version manager like mise/proto). `devEngines` **errors** on a mismatched Node; it only **warns** on a non-pnpm package manager, because the release pipeline publishes through npm (`changeset publish` → `npm publish`) and a hard error there would block publishing.
