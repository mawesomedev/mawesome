# Shells and Node managers

The shim must be the first `npm` on `PATH`. Node managers rewrite `PATH` when they switch Node, so this page is about keeping it there.

## What fnm and nvm do

- **fnm** (`fnm use`, `--use-on-cd`, a git `post-checkout` hook) never changes `PATH`. It repoints a per-shell symlink that `fnm env` put there once. A shim directory added after `eval "$(fnm env)"` stays first forever, including when a hook switches Node.
- **nvm** (`nvm use`) replaces its own `PATH` entry in place, so the shims usually stay first. It prepends instead when nvm is not on `PATH` yet (a shell without a default alias) or when `/bin`, `/usr/bin` or `/usr/local/bin` comes before its entry. In those cases nvm's `bin` shadows the shims until the next prompt.

## The prompt hook

`setup` adds a small function to the shell's prompt hook (`precmd_functions` in zsh, `PROMPT_COMMAND` in bash, the `fish_prompt` event in fish, a `prompt` wrapper in PowerShell). Before each prompt it checks the first `PATH` entry and, when something else got in front, moves `shims/` back to the front. It uses parameter expansion only: no process is spawned, nothing is printed, `$?` and `$LASTEXITCODE` are preserved, and an existing hook keeps running.

The snippet is idempotent; `npm-vm init <shell>` prints it. It lives in the file the shell reads for interactive sessions, after your Node manager's init line:

| Shell      | `PATH` snippet                                                                | Hook                        |
| ---------- | ----------------------------------------------------------------------------- | --------------------------- |
| zsh        | `${ZDOTDIR:-~}/.zshenv`                                                       | `${ZDOTDIR:-~}/.zshrc`      |
| bash       | `~/.bashrc` and the login file (`.bash_profile`, `.bash_login` or `.profile`) | `~/.bashrc`                 |
| fish       | `~/.config/fish/conf.d/npm-vm.fish`                                           | same file, interactive only |
| PowerShell | the `CurrentUserAllHosts` profile of each installed host                      | same                        |

`setup` prints the snippet instead of editing a profile that is a symlink, not writable, inside the Nix store, managed by chezmoi, or a signed PowerShell profile under `AllSigned`. `--no-modify-profile` forces that.

## The one gap, and link mode

A hook runs at the next prompt, so `nvm use 22 && npm -v` on a single line can still hit nvm's npm when nvm prepended. Link mode closes it:

```sh
npm-vm setup --link
```

It replaces `npm` and `npx` inside every Node that nvm, fnm or nvm-windows installed with the shim, keeping the original beside it as `npm.npm-vm-original`, and records both. Whatever `PATH` says, `npm` is then the shim. `doctor` reports an install that is not linked and a link that something replaced (for example `npm i -g npm@11`, which npm-vm then leaves alone). `uninstall` puts the originals back.

Link mode touches files inside Node installs; that is why it is opt-in.

## Git hooks, IDEs, scripts

Anything that runs with the shell's `PATH` runs the shim: git hooks, editor terminals, `npm run` scripts (npm adds its own `bin` directory for lifecycle scripts, so nested `npm` calls inside a script use the same npm that started the script, as npm has always done), and CI steps after the [Action](./action.md).

## Windows

`setup` writes the user `PATH` through `HKCU\Environment` and broadcasts the change, never `setx`, then asks you to restart open terminals and IDEs. The `.cmd` shim resolves `node.exe` through `PATH` only. With an execution policy that blocks unsigned scripts, no `.ps1` shim is installed and the `.cmd` shim serves PowerShell too. `--cmd-autorun` additionally registers a cmd AutoRun entry that puts the shims first in every cmd session; it is off by default because AutoRun affects every `cmd /c` ever spawned. `doctor` checks what `cmd`, PowerShell and `where npm` resolve.
