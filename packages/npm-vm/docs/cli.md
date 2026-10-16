# CLI reference

```
npm-vm <command> [options]
```

Global options: `--json` (machine-readable output where offered), `--version`, `--help`.

## Commands

| Command                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup [--link] [--shell <s>] [--yes] [--dry-run] [--no-modify-profile] [--cmd-autorun] [--strict]` | Installs the runtime and shims, edits the shell profiles after a per-file prompt, optionally links Node installs, then runs `doctor`. Every target is checked before anything is written. `--shell` repeats (`zsh`, `bash`, `fish`, `powershell`); the default is your login shell, PowerShell on Windows. `--strict` exits 2 when any target was skipped. |
| `init <shell> [--path\|--hook]`                                                                     | Prints the profile snippet for `zsh`, `bash`, `fish` or `powershell`. `--path` prepends `shims/` to `PATH`; `--hook` installs the prompt guard that moves it back to the front; default both. Sourcing a snippet twice changes nothing.                                                                                                                    |
| `doctor [--json]`                                                                                   | Read-only. Which `npm` each shell resolves, hook present, Node managers found, unlinked or changed links, leftover locks and journals, a project-local `node_modules/.bin/npm`. Exit 0 healthy, 1 problems, each with its fix.                                                                                                                             |
| `which [--json]`                                                                                    | The npm that would run for the current directory, and why.                                                                                                                                                                                                                                                                                                 |
| `pin [<range>]`                                                                                     | Writes `devEngines.packageManager` `{ name: "npm", version, onFail: "error" }` into the project's `package.json`, keeping other package managers and the file's indentation. Refuses to run inside a workspace member, since npm reads the root. Default range: `^<latest npm whose engines accept the active Node>`.                                      |
| `install [<spec>]`                                                                                  | Downloads and verifies the project's npm, or `<spec>`, into the cache.                                                                                                                                                                                                                                                                                     |
| `cache list [--json]`                                                                               | Cached versions with last use and live leases.                                                                                                                                                                                                                                                                                                             |
| `cache prune [--older-than <days>]`                                                                 | Removes entries unused for the given days (default 90), invalid entries and leftovers; never one in use.                                                                                                                                                                                                                                                   |
| `self-update [--rollback]`                                                                          | Updates npm-vm after verifying the registry signature and the SLSA provenance of the release against this repository's release workflow. Forward-only. `--rollback` is offline and restores the previous version.                                                                                                                                          |
| `recover --journal <id> --confirm-dead-machine <machine-id>`                                        | Finishes or undoes a change journal another machine left in a shared home, once you confirm that machine runs no npm-vm.                                                                                                                                                                                                                                   |
| `uninstall [--yes] [--purge-cache]`                                                                 | Removes profile blocks (only while unchanged since written), links, the Windows PATH entry and AutoRun, and the home. The cache stays unless `--purge-cache`.                                                                                                                                                                                              |

## Environment

| Variable         | Effect                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `NPM_VM_VERSION` | Use this range or version instead of the project's declaration.                                        |
| `NPM_VM_DISABLE` | Any value: always run Node's own npm.                                                                  |
| `NPM_VM_OFFLINE` | Any value: never contact the registry; a cached match or nothing.                                      |
| `NPM_VM_HOME`    | Where `setup` installs the home. The shims embed the path, so change it only by running `setup` again. |

## Messages

Every message names the cause, the file involved when there is one, and one command that fixes it. The ones you may meet:

| Situation                                | What you see                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The only matching npm needs a newer Node | `npm 12.2.0 needs Node ^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0, but the active Node is v24.12.0.` with the `nvm install` / `fnm use` hint |
| Nothing matches                          | `No npm version satisfies ^13 (…/package.json)`                                                                                        |
| Node's own npm is older than 8           | `Cannot download npm: Node's own npm 7.24.2 …; npm 8 or newer is needed as the transport.`                                             |
| The registry signed with an unknown key  | `The registry signed npm with key SHA256:…, which npm-vm does not know. Run npm-vm self-update …`                                      |
| An unsigned registry                     | `… serves npm 12.2.0 without a registry signature. Pin a tarball hash …`                                                               |
| A lock left by a crashed command         | `…/state/lock is locked by PID 4242 on laptop since …, which is no longer running. Delete …/state/lock and retry.`                     |
| A profile edited since `setup` wrote it  | `… changed since npm-vm wrote it; left untouched.`                                                                                     |

## Exit codes

See [How it works](./how-it-works.md#signals-and-exit-codes).
