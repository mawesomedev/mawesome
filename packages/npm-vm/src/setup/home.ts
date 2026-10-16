import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface MachineId {
	/** sha256 of the platform id, first 16 hex chars (spec DIST-2). */
	id: string;
	/** True when only the hostname was available, which cloned machines can share. */
	fallback: boolean;
}

/** Every directory the tool uses (spec DIST-1 and SET-1). */
export interface Dirs {
	home: string;
	cache: string;
	state: string;
	tmp: string;
	journal: string;
	machine: MachineId;
}

function localAppData(env: NodeJS.ProcessEnv): string {
	return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
}

export function defaultHome(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'win32') {
		return join(localAppData(env), 'npm-vm');
	}
	return join(env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'npm-vm');
}

export function cacheBase(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'win32') {
		return join(localAppData(env), 'npm-vm', 'cache');
	}
	return join(env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'npm-vm');
}

function platformId(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
	try {
		if (platform === 'linux') {
			for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
				try {
					const id = readFileSync(file, 'utf8').trim();
					if (id !== '') {
						return id;
					}
				} catch {
					// Try the next location.
				}
			}
			return null;
		}
		if (platform === 'darwin') {
			const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
				encoding: 'utf8',
				env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
			});
			return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
		}
		if (platform === 'win32') {
			const reg = join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
			const out = execFileSync(
				reg,
				['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
				{
					encoding: 'utf8',
				},
			);
			return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
		}
	} catch {
		// Fall back to the hostname below.
	}
	return null;
}

/** The hashed machine id, or a hashed hostname when the platform id is unreadable. */
export function readMachineId(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): MachineId {
	const raw = platformId(platform, env);
	const source = raw ?? hostname();
	return {
		id: createHash('sha256').update(source).digest('hex').slice(0, 16),
		fallback: raw === null,
	};
}

export function resolveDirs(
	env: NodeJS.ProcessEnv = process.env,
	home: string = env['NPM_VM_HOME'] || defaultHome(env),
	platform: NodeJS.Platform = process.platform,
	machine: MachineId = readMachineId(env, platform),
): Dirs {
	const state = join(home, 'state');
	return {
		home,
		cache: join(cacheBase(env, platform), machine.id),
		state,
		tmp: join(state, 'tmp'),
		journal: join(state, 'journal'),
		machine,
	};
}
