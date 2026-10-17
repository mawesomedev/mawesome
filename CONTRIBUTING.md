# Contributing

This document is the human-facing guide. [AGENTS.md](./AGENTS.md) is the authoritative reference for the full command list and the hard rules — please read it too (it applies to human contributors and AI agents alike).

## Prerequisites

- **Node `>=24.12`** (see `.nvmrc`).
- **pnpm 10**. Install pnpm standalone with `npm i -g pnpm@10`, the [pnpm install script](https://pnpm.io/installation), or a version manager (mise/proto). `devEngines` errors on a wrong Node version and warns (not errors) if you use a non-pnpm package manager — the release publishes through npm, so a hard error there would block it.

```sh
pnpm install
pnpm verify   # the full local gate
```

### Editor setup (optional)

Recommended VS Code settings are **opt-in**. Install the suggested extensions (VS Code will prompt from `.vscode/extensions.json`). The recommended settings are installed automatically: a `.vscode/tasks.json` task runs on **folder open** (once you grant VS Code Workspace Trust) and copies `.vscode/settings.dist.jsonc` to your local (gitignored) `.vscode/settings.json` — oxc as the formatter, format-on-save, and tsgo type-checking. You can also run it manually:

```sh
pnpm vscode:setup
```

It only writes/updates a `settings.json` that still carries the `@mawesome/managed-vscode-settings` marker, so your personal edits are never overwritten (delete the marker to take full ownership and opt out of updates).

## Repository layout

- `packages/*` — published `@mawesome/*` packages (each declares all of its own deps).
- `actions/*` — GitHub Actions, private workspaces published to their own mirror repositories.
- `tools/tsconfig` — `@mawesome/tsconfig`, the shared strict TypeScript base.
- `tools/repo` — repo-level dev CLIs (oxlint, oxfmt, syncpack, tsgo) and their configs.
- Root holds **no dependencies** except the `@changesets/*` release tooling (enforced by `pnpm check:root-deps`).

## Adding a package

Run `/add-package <name>` (or copy `templates/package/` to `packages/<name>`), then:

1. Set the package `name` to `@mawesome/<name>` and fill in `description`.
2. Declare dependencies as **caret ranges**. If a dependency is already used elsewhere in the repo, use the **exact same range** (syncpack enforces one version per dependency — `pnpm deps:fix` aligns them). Pick versions already older than the 3-day `minimumReleaseAge`. Internal `@mawesome/*` deps use `workspace:*`.
3. `pnpm install`, then `pnpm verify` until green.
4. Add a changeset (below).

## Adding an action

An `actions/<name>` workspace stays private and ships through the mirror repository named in its `package.json` `mirror` field. Before its first release, set up once:

1. Create the public mirror repository (`mawesomedev/<name>-action`) with an empty initial commit on `main`; the deploy script refuses a repository without one.
2. Add the mirror to the mawesome-bot GitHub App installation so `deploy-to-mirror.yml` can mint a token scoped to it.
3. Allow the tag pattern `@mawesome/<name>-action@*` in the `action-mirror` environment's deployment branch policies; without it the deploy job is rejected before it starts.
4. Reference the action in docs as `mawesomedev/<name>-action@<sha> # vX.Y.Z`. The mirror moves `vX.Y.Z` and the major tag `vX` on each release, so a 0.x line has `v0`, not `v1`.

Marketplace publication stays manual: releases made with the App token never reach the Marketplace, so edit the release in the mirror and tick "Publish this Action to the GitHub Marketplace" when wanted.

## Dependencies

- **syncpack** (`pnpm deps:lint`) enforces that every dependency uses **one identical version across the whole repo**, that the ranges are **caret**, and that internal `@mawesome/*` deps use `workspace:*`. Run `pnpm deps:fix` to auto-align mismatches.
- Caret ranges let security patches flow in; the committed lockfile pins exact resolved versions for reproducibility. (`@typescript/native-preview` is the exception — pinned exact.)
- A new dependency that ships an install/build script will fail `pnpm install` (`strictDepBuilds`). If it genuinely needs to build, raise a PR to add it to `onlyBuiltDependencies` in `pnpm-workspace.yaml` with justification.

## Changesets / releasing

Every change that affects a **published** package's behavior or public API needs a changeset. Pure internal/tooling/docs/test changes don't (use `pnpm changeset --empty` only if a required check demands one).

1. **Create one:** `pnpm changeset`. Select the affected `@mawesome/*` package(s), pick the bump — **patch** (fix), **minor** (backward-compatible feature), **major** (breaking; note `0.x` minors are still breaking under semver) — and write a clear, user-facing summary. It becomes the package's changelog entry. Commit the generated file in `.changeset/`.
2. **Don't hand-edit `CHANGELOG.md`** — changesets generates it.
3. **Release flow:** merges to `main` accumulate changesets. The `changesets/action` opens/updates a **"Version Packages"** PR that bumps versions and writes changelogs. Merging _that_ PR publishes the changed packages via npm **OIDC trusted publishing** (no tokens). A brand-new package name needs a one-time bootstrap before the trusted-publisher link can exist: publish a placeholder (`0.0.0-alpha.0`, `npm publish --access public --tag alpha`) from a 2FA account, then add the trusted publisher on npmjs.com (GitHub Actions, repository `mawesomedev/mawesome`, workflow `release.yml`, environment `npm-publish`).
4. Internal `@mawesome/*` dependents are bumped automatically (`updateInternalDependencies: patch`).
