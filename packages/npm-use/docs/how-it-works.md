# How it works

## The shim and the launcher

`setup` writes three one-line shims into `<home>/shims/`:

```sh
#!/bin/sh
# npm-use launcher abi=1
exec node "/home/me/.local/share/npm-use/bootstrap.cjs" npm "$@"
```

`node` is whatever Node is active, which is the point: the shim never chooses Node, only npm. On Windows there is a `.cmd` shim that resolves `node.exe` through `PATH` only (cmd would otherwise run a `node.exe` committed to the current directory) and a `.ps1` shim when the execution policy allows it.

`bootstrap.cjs` is a few lines of ES5 that any Node from 10 up can run. Below Node 22.9, it hands over to Node's own npm and prints one notice when the project declares an npm version. Otherwise it reads `current`, a file naming the installed runtime version, loads `versions/<v>/runtime.cjs`, checks that the runtime's launcher ABI is one it supports, and calls it. The runtime is the compiled tool; the launcher never changes except through `self-update`, which replaces it in a journaled two-phase swap.

## Resolution order

For every `npm` or `npx` call, in this order:

1. `NPM_USE_DISABLE` set: Node's own npm.
2. Global mode (`-g`, `--global`, `--location=global`, `npm_config_global`): Node's own npm. Globals follow Node, only the CLI follows the project.
3. `NPM_USE_VERSION` set: that range or version is the only requirement.
4. Otherwise the project root is found exactly as npm finds its `localPrefix`: a CLI `--prefix` is final; else the nearest directory with `package.json` or `node_modules`, promoted to a parent whose `workspaces` include it unless `--no-workspaces` is given. A test corpus checks this against real npm 8, 10, 11 and 12.
5. The root's `package.json` is read. No npm declaration: Node's own npm.
6. Node's own npm satisfies any declared range without a hash: it runs, no network, no cache.
7. Otherwise the candidates are every published version matching any declared range whose `engines.node` accepts the active Node. The highest cached candidate wins; if none is cached, the highest from the registry.
8. Nothing fits: the policy decides (below).

## What counts as a declaration

```jsonc
// object form
"devEngines": { "packageManager": { "name": "npm", "version": "^12.0.0", "onFail": "error" } }

// array form: entries are alternatives, non-npm entries are ignored
"devEngines": { "packageManager": [ { "name": "npm", "version": "^11.18" }, { "name": "npm", "version": "^12" } ] }

// exact version with a tarball hash: never satisfied by Node's own npm, verified byte for byte
"devEngines": { "packageManager": { "name": "npm", "version": "12.2.0+sha512.<hex>" } }

// legacy field, used only when devEngines has no npm entry
"packageManager": "npm@12.2.0"
```

A version is a semver range, an exact version, or an exact version with `+sha512.`, `+sha256.` or `+sha224.` and the hex digest. Tags such as `latest`, URLs and anything else are rejected.

## The failure policy

`onFail` of the last `devEngines.packageManager` entry (the object itself, or the last array element whatever its name) decides what happens when no version fits, when the registry cannot be reached, or when the only match needs a newer Node:

| `onFail`                         | Behaviour                                           |
| -------------------------------- | --------------------------------------------------- |
| `error` (default) and `download` | Fail with exit code 3 and a message naming the fix. |
| `warn`                           | Print the message, run Node's own npm.              |
| `ignore`                         | Run Node's own npm silently.                        |

## The cache

Verified releases live under `~/.cache/npm-use/<machine-id>/npm/<version>-<integrity prefix>/` (`%LOCALAPPDATA%\npm-use\cache\...` on Windows). The directory name carries the integrity, so two registries serving different bytes for the same version get two entries. Entries are write-once: a running `npm` holds a shared lease on its entry and `cache prune` is the only thing that ever deletes one, never while a lease is live. The machine id in the path keeps a home shared over NFS from mixing leases between machines.

```sh
npm-use cache list
npm-use cache prune --older-than 30   # default 90 days since last use
```

## Signals and exit codes

The launcher forwards `SIGTERM` and `SIGHUP` to npm at once. `SIGINT` and `SIGQUIT` are forwarded only if npm is still running a second later, because a terminal already delivered them to the whole process group. When npm exits by a signal, the launcher exits by the same signal; otherwise with npm's exit code.

Exit codes of `npm-use` itself, and of the shim before npm starts:

| Code | Meaning                                                                                    |
| ---- | ------------------------------------------------------------------------------------------ |
| 0    | OK                                                                                         |
| 1    | `doctor` found problems, or an unexpected error                                            |
| 2    | `setup --strict` skipped a target                                                          |
| 3    | Resolution failed (no version fits, Node too old for the only match, registry unreachable) |
| 4    | Node's own npm cannot act as the download transport (older than 8, or missing)             |
| 5    | Verification failed (integrity, signature, unsafe tarball, provenance)                     |
| 6    | Launcher and runtime disagree on the ABI; rerun `setup`                                    |
| 64   | Usage error                                                                                |

Once npm runs, its own exit code is returned.
