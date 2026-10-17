# GitHub Action

`mawesomedev/npm-vm-action` gives a job the npm its project declares, cached between runs. It is built from [`actions/npm-vm`](https://github.com/mawesomedev/mawesome/tree/main/actions/npm-vm) and released to its own repository.

## Workflow

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-node@v5
    with:
      node-version: 24
  - uses: mawesomedev/npm-vm-action@<sha> # vX.Y.Z
  - run: npm ci
  - run: npm test
```

The action installs the launcher and shims under `RUNNER_TEMP`, adds `shims/` to `GITHUB_PATH`, and resolves the version once, so every later `npm` and `npx` in the job runs that exact version. When Node's own npm already satisfies the project, nothing is downloaded.

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

## What is cached

Only the verified npm tarball and a small index (version, integrity, registry signatures, publication time, `engines.node`). Never extracted files, `.npmrc`, credentials or the home. The key is `npm-vm-v1-<runner OS>-node<full Node version>-<registry id>-<constraint hash>-<version>-<integrity prefix>`; restore keys drop the last two, so a restored tarball that still satisfies the range is reused and a download happens only when it does not. Every restore is verified again before extraction.

## Permissions

None. The action needs no token.

## Release

Each release of `@mawesome/npm-vm-action` is mirrored to `mawesomedev/npm-vm-action` with the bundled `dist/`, tagged `v<version>`, with the major tag moved. Pin the action to a commit SHA in your workflow.
