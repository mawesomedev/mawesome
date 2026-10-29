# mawesome

A monorepo of sharp, single-purpose developer tools.

📖 Docs and playgrounds: **[mawesome.dev](https://mawesome.dev)**

## Tools

### 📦 npm packages

| Package                                                        | What it does                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔍 [`@mawesome/dependency-audit`](./packages/dependency-audit) | Verify every reachable import in a package's released artifact is declared and resolvable. ([npm](https://www.npmjs.com/package/@mawesome/dependency-audit) · [docs](https://mawesome.dev/dependency-audit/) · [playground](https://mawesome.dev/dependency-audit/playground/)) |
| 🔄 [`@mawesome/npm-vm`](./packages/npm-vm)                     | Run the npm version a project declares in `devEngines`, whatever Node is active. ([npm](https://www.npmjs.com/package/@mawesome/npm-vm) · [docs](https://mawesome.dev/npm-vm/))                                                                                                 |
| ✅ [`@mawesome/pr-baseline`](./packages/pr-baseline)           | Keep open pull requests current with a movable baseline on the base branch, as a CLI and a library. ([npm](https://www.npmjs.com/package/@mawesome/pr-baseline) · [docs](https://mawesome.dev/pr-baseline/))                                                                    |

### ⚙️ GitHub Actions

Each action is published to its own mirror repository on release; consumers reference the mirror, never this repository.

| Action                                                       | What it does                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔄 [`mawesomedev/npm-vm-action`](./actions/npm-vm)           | Run the npm version a project declares in `devEngines` in CI, with the download cached between runs. ([mirror](https://github.com/mawesomedev/npm-vm-action) · [docs](https://mawesome.dev/npm-vm/action/))         |
| ✅ [`mawesomedev/pr-baseline-action`](./actions/pr-baseline) | Run pr-baseline on pull requests, merges, pushes and a schedule, writing one commit status per PR. ([mirror](https://github.com/mawesomedev/pr-baseline-action) · [docs](https://mawesome.dev/pr-baseline/action/)) |

## Quickstart

```sh
# Requires Node >=24.12 and pnpm 10 (see CONTRIBUTING.md).
pnpm install
pnpm verify   # lint, format, deps, typecheck, test, build, exports: the full gate
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started. [AGENTS.md](./AGENTS.md) is the authoritative command and rule reference, for humans and AI agents alike.

## License

[MIT](./LICENSE)
