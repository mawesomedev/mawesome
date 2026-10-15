# npm-use documentation

Reference documentation for `@mawesome/npm-use`, a per-project npm version manager: every `npm` and `npx` call runs the version the project declares in `devEngines.packageManager`, whatever Node is active and whatever nvm or fnm did to `PATH`.

## Contents

- [Get started](./get-started.md): install in one command, pin a version, check with `doctor`.
- [How it works](./how-it-works.md): the shim, the launcher, resolution order, the cache and the exit codes.
- [CLI reference](./cli.md): every command, flag, environment variable and message.
- [Shells and Node managers](./shells.md): what nvm and fnm do to `PATH`, the prompt hook, link mode, Windows.
- [Security](./security.md): what is verified, what is never read, and the threat model.
- [GitHub Action](./action.md): the same npm in CI, cached between runs.

## One-paragraph summary

A shim named `npm` sits first on `PATH`. On every call it reads `devEngines.packageManager` from the project npm itself would use, and when Node's own npm satisfies the range it runs that npm unchanged. Otherwise it picks the newest matching release whose `engines.node` accepts the active Node, downloads it once through Node's own npm, checks the registry signature and the tarball integrity, extracts it into a per-machine cache and runs it from there. Global installs always use Node's own npm. Nothing is pinned per Node version, nothing is written into a Node install unless `--link` asks for it, and a project that declares nothing sees no difference at all.
