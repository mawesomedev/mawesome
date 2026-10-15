# Get started

## Install

```sh
npx --prefix ~ -y @mawesome/npm-use setup
```

`--prefix ~` keeps npx out of the current project, so the command works inside a project whose `devEngines` rejects the npm you have. `setup` installs the launcher under `~/.local/share/npm-use` (`%LOCALAPPDATA%\npm-use` on Windows), writes the `npm`, `npx` and `npm-use` shims, shows the exact change it wants to make to your shell profile and asks before writing it. Pass `--yes` to skip the prompt, `--dry-run` to only look, or `--no-modify-profile` to get the snippet printed instead.

Open a new terminal and check:

```sh
npm-use doctor
```

`doctor` is read-only. It reports which `npm` each of your shells resolves, whether the prompt hook is in place, Node managers it found, and anything left over from an interrupted command, each with its fix.

## Declare the npm a project needs

```sh
npm-use pin ^12.0.0
```

This writes the object form npm itself reads:

```json
{
	"devEngines": {
		"packageManager": { "name": "npm", "version": "^12.0.0", "onFail": "error" }
	}
}
```

Without a range, `pin` uses `^<latest npm whose engines accept your Node>`. The array form and the legacy `packageManager: "npm@12.2.0"` field are honoured too; see [How it works](./how-it-works.md#what-counts-as-a-declaration).

## Use it

```sh
npm ci        # runs npm ^12 here, downloaded once
cd ../other   # a project that declares nothing
npm -v        # Node's own npm, untouched
```

The first call in a project that needs a download fetches the release through Node's own npm (so your `.npmrc` registry, proxy and credentials apply), verifies it and caches it. Every later call, in any project needing that version, starts from the cache with no network.

## For nvm users

`nvm use` can put its own `bin` directory in front of the shims. The prompt hook `setup` installs moves the shims back before the next prompt, so `nvm use 22 && npm -v` on one line is the only case it cannot cover. For that, run `npm-use setup --link`: it replaces `npm` and `npx` inside every installed Node with the shim, so `PATH` order stops mattering. [Shells and Node managers](./shells.md) explains both.

## In CI

Use the [GitHub Action](./action.md) or run the one-liner above in a step; the Action also caches the verified tarball between runs.

## Uninstall

```sh
npm-use uninstall
```

Removes the profile blocks it wrote (only if you have not edited them since), restores any linked Node installs, and deletes the home. The cache stays unless you add `--purge-cache`.
