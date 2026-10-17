# npm-vm documentation

Reference documentation for `@mawesome/npm-vm`, a per-project npm version manager: every `npm` and `npx` call runs the version the project declares in `devEngines.packageManager`, whatever Node is active and whatever nvm or fnm did to `PATH`.

## Contents

- [Get started](./get-started.md): install in one command, pin a version, check with `doctor`.
- [How it works](./how-it-works.md): the shim, the launcher, resolution order, the cache and the exit codes.
- [CLI reference](./cli.md): every command, flag, environment variable and message.
- [Shells and Node managers](./shells.md): what nvm and fnm do to `PATH`, the prompt hook, link mode, Windows.
- [Security](./security.md): what is verified, what is never read, and the threat model.
- [GitHub Action](./action.md): the same npm in CI, cached between runs.
