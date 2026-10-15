# @mawesome/npm-use

> Run the npm version a project declares in `devEngines`, whatever Node is active.

A new npm ships, your projects want it, and no Node release bundles it yet. Or an old branch still needs the npm it was built with. `npm-use` puts an `npm` shim first on `PATH` that reads `devEngines.packageManager` from the project npm itself would use. When Node's own npm satisfies the range, it runs unchanged. Otherwise the newest matching release that supports the active Node is downloaded once through Node's own npm, signature-checked, extracted safely into a per-machine cache and run from there. It works with nvm, fnm and nvm-windows, from hooks, IDEs and scripts, and a project that declares nothing sees no difference.

📚 Full documentation lives in [`docs/`](./docs/): [get started](./docs/get-started.md), [how it works](./docs/how-it-works.md), [CLI](./docs/cli.md), [shells and Node managers](./docs/shells.md), [security](./docs/security.md), [GitHub Action](./docs/action.md).

## Install

```sh
npx --prefix ~ -y @mawesome/npm-use setup
```

Then open a new terminal and run `npm-use doctor`.

## Declare

```sh
npm-use pin ^12.0.0
```

```json
{
	"devEngines": {
		"packageManager": { "name": "npm", "version": "^12.0.0", "onFail": "error" }
	}
}
```

## Use

```sh
npm ci    # npm ^12 in this project
npm -v    # Node's own npm in a project that declares nothing
```

Global installs (`npm i -g`) always use Node's own npm.

## In CI

```yaml
- uses: mawesomedev/npm-use-action@v1
```

## Requirements

Node 22.9 or newer runs the tool; below that the launcher falls back to Node's own npm and says so. Node's own npm must be 8 or newer to act as the download transport.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
