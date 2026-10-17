import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

/** A process plus the start identity that tells it apart from a later process reusing its PID (spec PROC-1). */
export interface ProcessIdentity {
	pid: number;
	/** Platform-specific start identity, compared as an exact string; null when unreadable. */
	start: string | null;
}

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(
		env['SystemRoot'] ?? 'C:\\Windows',
		'System32',
		'WindowsPowerShell',
		'v1.0',
		'powershell.exe',
	);
}

const SHELL_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin'];

/**
 * An absolute path for a shell to probe (spec SEC-8): the login shell when `$SHELL` is absolute, else system dirs.
 * Never PATH, which inside an npm script starts with `node_modules/.bin`.
 */
export function shellBinary(
	shell: 'zsh' | 'bash' | 'fish' | 'powershell',
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const name = shell === 'powershell' ? 'pwsh' : shell;
	if (platform === 'win32') {
		const pwsh = join(env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
		return shell === 'powershell' && existsSync(pwsh) ? pwsh : null;
	}
	const login = env['SHELL'];
	const candidates = [
		...(login !== undefined && isAbsolute(login) && basename(login) === name ? [login] : []),
		...SHELL_DIRS.map((dir) => join(dir, name)),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The start identity of `pid`, or null when the lookup fails or is ambiguous. */
export function startIdentity(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	try {
		if (platform === 'linux') {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			// The command name sits in parentheses and may hold spaces; fields are counted after the last one.
			const after = stat
				.slice(stat.lastIndexOf(')') + 1)
				.trim()
				.split(/\s+/);
			const start = after[19];
			return start !== undefined && /^\d+$/.test(start) ? start : null;
		}
		if (platform === 'darwin') {
			const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
				encoding: 'utf8',
				env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
			}).trim();
			return out === '' || out.includes('\n') ? null : out;
		}
		if (platform === 'win32') {
			const out = execFileSync(
				powershellPath(env),
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
				],
				{ encoding: 'utf8', windowsHide: true },
			).trim();
			return /^\d+$/.test(out) ? out : null;
		}
	} catch {
		return null;
	}
	return null;
}

export function ownIdentity(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): ProcessIdentity {
	return { pid: process.pid, start: startIdentity(process.pid, platform, env) };
}

/**
 * Whether the recorded process still runs: dead only when the PID is gone or its start identity differs.
 * Any failure to look up means live, so nothing ever expires a process that merely cannot be inspected.
 */
export function isLive(
	identity: ProcessIdentity,
	platform: NodeJS.Platform = process.platform,
): boolean {
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
			return false;
		}
		return true;
	}
	if (identity.start === null) {
		return true;
	}
	const current = startIdentity(identity.pid, platform);
	return current === null || current === identity.start;
}
