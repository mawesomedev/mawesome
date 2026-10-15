import { win32 } from 'node:path';
import { assertSafeHome, SHIM_DIR, shimDir } from './shims.ts';

export const SHELLS = ['zsh', 'bash', 'fish', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
	return (SHELLS as readonly string[]).includes(value);
}

export const BLOCK_START = '# >>> npm-use >>>';
export const BLOCK_END = '# <<< npm-use <<<';

/** Escapes a path for use inside a bash or zsh `${var//pattern/}` pattern, where `/` and glob characters are special. */
function patternOf(path: string): string {
	return path.replace(/[\\/*?[\]]/g, (char) => `\\${char}`);
}

/** Adds `shims/` to the front of PATH when absent; sourcing it twice changes nothing (spec SH-1). */
function shimsFor(shell: Shell, home: string): string {
	return shell === 'powershell' ? win32.join(home, SHIM_DIR) : shimDir(home);
}

export function pathSnippet(shell: Shell, home: string): string {
	assertSafeHome(home);
	const shims = shimsFor(shell, home);
	switch (shell) {
		case 'zsh':
		case 'bash':
			return [
				`case ":$PATH:" in`,
				`  *":${shims}:"*) ;;`,
				`  *) export PATH="${shims}:$PATH" ;;`,
				'esac',
				'',
			].join('\n');
		case 'fish':
			return [
				`if not contains -- "${shims}" $PATH`,
				`    set -gx PATH "${shims}" $PATH`,
				'end',
				'',
			].join('\n');
		case 'powershell':
			return [
				`if (($env:Path -split [IO.Path]::PathSeparator) -notcontains '${shims}') {`,
				`    $env:Path = '${shims}' + [IO.Path]::PathSeparator + $env:Path`,
				'}',
				'',
			].join('\n');
	}
}

/**
 * The prompt hook (spec SH-2): moves `shims/` back to the front when something prepended over it,
 * with parameter expansion only, keeping `$?` and chaining whatever hook was there.
 */
export function hookSnippet(shell: Shell, home: string): string {
	assertSafeHome(home);
	const shims = shimsFor(shell, home);
	switch (shell) {
		case 'zsh':
			return [
				'_npm_use_guard() {',
				'  local ret=$?',
				`  if [[ "$path[1]" != "${shims}" ]]; then`,
				`    path=("${shims}" \${path:#${shims}})`,
				'  fi',
				'  return $ret',
				'}',
				'if [[ -z "${precmd_functions[(r)_npm_use_guard]}" ]]; then',
				'  precmd_functions+=(_npm_use_guard)',
				'fi',
				'',
			].join('\n');
		case 'bash':
			return [
				'_npm_use_guard() {',
				'  local ret=$?',
				`  case ":$PATH:" in`,
				`    ":${shims}:"*) ;;`,
				'    *)',
				'      local rest=":$PATH:"',
				`      rest="\${rest//:${patternOf(shims)}:/:}"`,
				'      rest="${rest#:}"',
				'      rest="${rest%:}"',
				`      PATH="${shims}\${rest:+:$rest}"`,
				'      ;;',
				'  esac',
				'  return $ret',
				'}',
				'case ";${PROMPT_COMMAND};" in',
				'  *";_npm_use_guard;"*) ;;',
				'  *) PROMPT_COMMAND="_npm_use_guard${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
				'esac',
				'',
			].join('\n');
		case 'fish':
			return [
				'if status is-interactive',
				'    function _npm_use_guard --on-event fish_prompt',
				`        if test "$PATH[1]" != "${shims}"`,
				`            set -l found (contains -i -- "${shims}" $PATH)`,
				'            if test -n "$found"',
				'                set -e PATH[$found]',
				'            end',
				`            set -gx PATH "${shims}" $PATH`,
				'        end',
				'    end',
				'end',
				'',
			].join('\n');
		case 'powershell':
			return [
				'if (-not (Test-Path Function:\\global:_npm_use_original_prompt)) {',
				'    $prev = Get-Item Function:\\prompt -ErrorAction SilentlyContinue',
				'    if ($prev) { Set-Item Function:\\global:_npm_use_original_prompt $prev.ScriptBlock }',
				'    else { function global:_npm_use_original_prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)$(\'>\' * ($nestedPromptLevel + 1)) " } }',
				'    function global:prompt {',
				'        $exit = $global:LASTEXITCODE',
				'        $ok = $?',
				`        $shims = '${shims}'`,
				'        $parts = @($env:Path -split [IO.Path]::PathSeparator)',
				'        if ($parts.Length -eq 0 -or $parts[0] -ne $shims) {',
				'            $env:Path = (@($shims) + @($parts | Where-Object { $_ -ne $shims })) -join [IO.Path]::PathSeparator',
				'        }',
				'        $out = & $function:global:_npm_use_original_prompt',
				'        $global:LASTEXITCODE = $exit',
				'        $out',
				'    }',
				'}',
				'',
			].join('\n');
	}
}

/** Both snippets inside the marked block `setup` writes and `uninstall` removes (spec SH-4). */
export function profileBlock(
	shell: Shell,
	home: string,
	parts: { path: boolean; hook: boolean },
): string {
	const body = [
		parts.path ? pathSnippet(shell, home) : '',
		parts.hook ? hookSnippet(shell, home) : '',
	]
		.filter((text) => text !== '')
		.join('');
	return `${BLOCK_START}\n${body}${BLOCK_END}\n`;
}
