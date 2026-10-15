import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BLOCK_END,
	BLOCK_START,
	hookSnippet,
	pathSnippet,
	profileBlock,
} from '../../src/setup/shell.ts';

const HOME = '/opt/npm-use home';
const SHIMS = `${HOME}/shims`;

interface PosixShell {
	name: string;
	bin: string;
	kind: 'zsh' | 'bash';
}

const candidates: PosixShell[] = [
	{ name: 'zsh', bin: 'zsh', kind: 'zsh' },
	{ name: 'bash 3.2', bin: '/bin/bash', kind: 'bash' },
	{ name: 'bash 5', bin: '/opt/homebrew/bin/bash', kind: 'bash' },
	{ name: 'bash', bin: '/usr/bin/bash', kind: 'bash' },
];
const shells = candidates.filter((shell) => shell.bin === 'zsh' || existsSync(shell.bin));

function runShell(shell: PosixShell, script: string, path: string): string {
	const args =
		shell.kind === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
	return execFileSync(shell.bin, args, {
		encoding: 'utf8',
		env: { PATH: path, HOME: '/nonexistent' },
	}).trim();
}

describe('snippets', () => {
	it('wrap the block with the markers and compose both parts', () => {
		const block = profileBlock('zsh', HOME, { path: true, hook: true });
		expect(block.startsWith(`${BLOCK_START}\n`)).toBe(true);
		expect(block.endsWith(`${BLOCK_END}\n`)).toBe(true);
		expect(block).toContain(pathSnippet('zsh', HOME));
		expect(block).toContain(hookSnippet('zsh', HOME));
		expect(profileBlock('fish', HOME, { path: true, hook: false })).not.toContain('fish_prompt');
	});

	it('fish and PowerShell snippets reference the shims and stay interactive-only or wrapped', () => {
		expect(pathSnippet('fish', HOME)).toContain(`contains -- "${SHIMS}" $PATH`);
		expect(hookSnippet('fish', HOME)).toContain('status is-interactive');
		expect(hookSnippet('fish', HOME)).toContain('--on-event fish_prompt');
		expect(pathSnippet('powershell', 'C:\\npm-use')).toContain("'C:\\npm-use\\shims'");
		expect(hookSnippet('powershell', 'C:\\npm-use')).toContain('$global:LASTEXITCODE = $exit');
		expect(hookSnippet('powershell', 'C:\\npm-use')).toContain('_npm_use_original_prompt');
		expect(hookSnippet('powershell', 'C:\\npm-use')).toContain('if (-not $ok) { Write-Error');
	});

	it('refuse an unsafe home', () => {
		expect(() => pathSnippet('bash', '/home/$evil')).toThrow(/NPM_USE_HOME/);
	});
});

describe.skipIf(shells.length === 0)('posix snippets in real shells', () => {
	for (const shell of shells) {
		describe(shell.name, () => {
			const path = pathSnippet(shell.kind, HOME);
			const hook = hookSnippet(shell.kind, HOME);

			it('path snippet prepends once, even when sourced twice', () => {
				const out = runShell(shell, `${path}\n${path}\necho "$PATH"`, '/usr/bin:/bin');
				expect(out).toBe(`${SHIMS}:/usr/bin:/bin`);
				const already = runShell(shell, `${path}\necho "$PATH"`, `/x:${SHIMS}:/bin`);
				expect(already).toBe(`/x:${SHIMS}:/bin`);
			});

			it('hook moves shims to the front, registers once, and keeps the exit status', () => {
				const script = [
					hook,
					hook,
					'PATH="/nvm/bin:/usr/bin:' + SHIMS + ':/bin"',
					'false',
					'_npm_use_guard',
					'echo "status=$?"',
					'echo "$PATH"',
					'_npm_use_guard',
					'echo "$PATH"',
					shell.kind === 'zsh'
						? 'echo "hooks=${#precmd_functions[@]} ${precmd_functions[*]}"'
						: 'echo "hooks=$PROMPT_COMMAND"',
				].join('\n');
				const lines = runShell(shell, script, '/usr/bin:/bin').split('\n');
				expect(lines[0]).toBe('status=1');
				expect(lines[1]).toBe(`${SHIMS}:/nvm/bin:/usr/bin:/bin`);
				expect(lines[2]).toBe(`${SHIMS}:/nvm/bin:/usr/bin:/bin`);
				expect(lines[3]).toBe(
					shell.kind === 'zsh' ? 'hooks=1 _npm_use_guard' : 'hooks=_npm_use_guard',
				);
			});

			it('hook chains an existing prompt hook and handles shims missing from PATH', () => {
				const existing =
					shell.kind === 'zsh'
						? 'precmd_functions=(mine)\nmine() { :; }'
						: 'PROMPT_COMMAND="mine"\nmine() { :; }';
				const script = [
					existing,
					hook,
					'PATH="/usr/bin:/bin"',
					'_npm_use_guard',
					'echo "$PATH"',
					shell.kind === 'zsh' ? 'echo "${precmd_functions[*]}"' : 'echo "$PROMPT_COMMAND"',
				].join('\n');
				const lines = runShell(shell, script, '/usr/bin:/bin').split('\n');
				expect(lines[0]).toBe(`${SHIMS}:/usr/bin:/bin`);
				expect(lines[1]).toBe(shell.kind === 'zsh' ? 'mine _npm_use_guard' : '_npm_use_guard;mine');
			});
		});
	}
});
