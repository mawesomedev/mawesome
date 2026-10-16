# npm-vm action

> Run the npm version a project declares in `devEngines`, whatever Node the job uses.

**This repository is generated.** It mirrors [`actions/npm-vm`](https://github.com/mawesomedev/mawesome/tree/main/actions/npm-vm) in [mawesomedev/mawesome](https://github.com/mawesomedev/mawesome) with the bundled `dist/` and a `release.json` naming the release added; open issues and pull requests there. Full documentation lives in the package's [docs](https://github.com/mawesomedev/mawesome/tree/main/packages/npm-vm/docs).

A project that declares `devEngines.packageManager` for npm gets that npm in CI without waiting for a Node release to bundle it. The action installs the `npm-vm` launcher and shims under `RUNNER_TEMP`, puts them first on `PATH`, resolves the version once, and verifies the download against the registry's signing keys. The verified tarball goes into the Actions cache, keyed by runner OS, Node version, registry, constraint, version and integrity, and is verified again before every restore is extracted.

## Usage

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-node@v5
    with:
      node-version: 24
  - uses: mawesomedev/npm-vm-action@v1
  - run: npm ci
```

Every `npm` and `npx` in later steps runs the declared version. When Node's own npm already satisfies the project, nothing is downloaded and that npm runs.

## Inputs

| Input               | Description                                                            | Default |
| ------------------- | ---------------------------------------------------------------------- | ------- |
| `working-directory` | The project whose `devEngines.packageManager` decides the npm version. | `.`     |
| `version`           | An npm range or version to use instead of the project's declaration.   |         |
| `cache`             | Keep the verified npm tarball in the Actions cache between runs.       | `true`  |

## Outputs

| Output      | Description                                           |
| ----------- | ----------------------------------------------------- |
| `version`   | The npm version every later step runs.                |
| `kind`      | `own` for Node's bundled npm, `cached` or `download`. |
| `cli-path`  | Absolute path to that npm's `bin/npm-cli.js`.         |
| `cache-hit` | Whether the tarball came from the Actions cache.      |

## Permissions

None. The action needs no token: it reads the registry and the Actions cache only.

## License

[MIT](./LICENSE)
