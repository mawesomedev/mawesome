import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { powershellPath } from '../state/proc.ts';

/*
 * Windows integration (spec WIN-1 to WIN-3). Every helper runs by absolute path with no profile (SEC-8).
 * `[Environment]::SetEnvironmentVariable(..., 'User')` writes HKCU\Environment and broadcasts WM_SETTINGCHANGE, so no setx.
 */

function powershell(env: NodeJS.ProcessEnv, command: string): string {
	return execFileSync(powershellPath(env), ['-NoProfile', '-NonInteractive', '-Command', command], {
		encoding: 'utf8',
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function regExe(env: NodeJS.ProcessEnv): string {
	return join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
}

function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function readUserPath(env: NodeJS.ProcessEnv): string {
	return powershell(env, "[Environment]::GetEnvironmentVariable('Path', 'User')");
}

export function writeUserPath(env: NodeJS.ProcessEnv, value: string): void {
	powershell(env, `[Environment]::SetEnvironmentVariable('Path', ${quote(value)}, 'User')`);
}

function sameDir(a: string, b: string): boolean {
	return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/** Prepends `dir` to the user PATH unless present; returns whether anything changed. */
export function addToUserPath(env: NodeJS.ProcessEnv, dir: string): boolean {
	const current = readUserPath(env);
	const parts = current.split(';').filter((part) => part !== '');
	if (parts.some((part) => sameDir(part, dir))) {
		return false;
	}
	writeUserPath(env, [dir, ...parts].join(';'));
	return true;
}

export function removeFromUserPath(env: NodeJS.ProcessEnv, dir: string): boolean {
	const current = readUserPath(env);
	const parts = current.split(';').filter((part) => part !== '');
	const kept = parts.filter((part) => !sameDir(part, dir));
	if (kept.length === parts.length) {
		return false;
	}
	writeUserPath(env, kept.join(';'));
	return true;
}

const AUTORUN_KEY = 'HKCU\\Software\\Microsoft\\Command Processor';
const AUTORUN_MARK = 'npm-vm';

export function readCmdAutoRun(env: NodeJS.ProcessEnv): string | null {
	try {
		const out = execFileSync(regExe(env), ['query', AUTORUN_KEY, '/v', 'AutoRun'], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return /AutoRun\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

/** The cmd AutoRun entry that puts shims first in every cmd session; only with `--cmd-autorun` (WIN-3). */
export function autoRunCommand(shimsDir: string): string {
	return `set "PATH=${shimsDir};%PATH%" & rem ${AUTORUN_MARK}`;
}

export function setCmdAutoRun(env: NodeJS.ProcessEnv, shimsDir: string): void {
	const existing = readCmdAutoRun(env);
	const ours = autoRunCommand(shimsDir);
	const kept = existing === null || existing.includes(AUTORUN_MARK) ? '' : existing;
	const value = kept === '' ? ours : `${ours} & ${kept}`;
	execFileSync(
		regExe(env),
		['add', AUTORUN_KEY, '/v', 'AutoRun', '/t', 'REG_SZ', '/d', value, '/f'],
		{
			windowsHide: true,
			stdio: 'ignore',
		},
	);
}

export function clearCmdAutoRun(env: NodeJS.ProcessEnv): boolean {
	const existing = readCmdAutoRun(env);
	if (existing === null || !existing.includes(AUTORUN_MARK)) {
		return false;
	}
	const rest = existing
		.split(' & ')
		.filter((part) => !part.includes(AUTORUN_MARK))
		.join(' & ');
	if (rest === '') {
		execFileSync(regExe(env), ['delete', AUTORUN_KEY, '/v', 'AutoRun', '/f'], {
			windowsHide: true,
			stdio: 'ignore',
		});
	} else {
		execFileSync(
			regExe(env),
			['add', AUTORUN_KEY, '/v', 'AutoRun', '/t', 'REG_SZ', '/d', rest, '/f'],
			{
				windowsHide: true,
				stdio: 'ignore',
			},
		);
	}
	return true;
}

/** Whether the effective execution policy lets our unsigned `.ps1` shims run (spec WIN-2). */
export function powershellAllowsScripts(policy: string | null): boolean {
	return policy !== null && !['Restricted', 'AllSigned', 'Undefined'].includes(policy);
}

/** Which `npm` each Windows context resolves first, for `doctor`. */
export function windowsWinners(
	env: NodeJS.ProcessEnv,
): Array<{ context: string; path: string | null }> {
	const results: Array<{ context: string; path: string | null }> = [];
	try {
		const out = execFileSync(
			join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe'),
			['npm'],
			{
				encoding: 'utf8',
				env,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		);
		results.push({ context: 'cmd', path: out.split(/\r?\n/)[0] ?? null });
	} catch {
		results.push({ context: 'cmd', path: null });
	}
	try {
		results.push({
			context: 'PowerShell',
			path: powershell(env, '(Get-Command npm -All | Select-Object -First 1).Source') || null,
		});
	} catch {
		results.push({ context: 'PowerShell', path: null });
	}
	return results;
}
