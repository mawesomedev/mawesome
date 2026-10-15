import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { atomicWrite } from '../state/atomic.ts';
import { mutateFile } from '../state/journal.ts';
import type { OwnerRecord } from '../state/lease.ts';
import { captureMeta, sha256 } from '../state/meta.ts';
import { powershellPath } from '../state/proc.ts';
import type { Dirs } from './home.ts';
import { BLOCK_END, BLOCK_START, profileBlock, type Shell } from './shell.ts';

export interface ProfileParts {
	path: boolean;
	hook: boolean;
}

/** One file `setup` would edit for one shell (spec SH-3). */
export interface ProfileTarget {
	shell: Shell;
	file: string;
	parts: ProfileParts;
}

export interface ProfileRecord {
	file: string;
	shell: Shell;
	parts: ProfileParts;
	/** sha256 of the whole file as written, so `uninstall` can tell a later edit (spec MUT-5). */
	writtenSha256: string;
	backup: string | null;
	updatedAt: string;
}

export interface ProfilesFile {
	version: 1;
	entries: ProfileRecord[];
}

export const PROFILES_FILE = 'profiles.json';

const BLOCK_RE = /^# >>> npm-use >>>\n[\s\S]*?^# <<< npm-use <<<\n?/m;

function bashLoginFile(home: string): string {
	for (const name of ['.bash_profile', '.bash_login', '.profile']) {
		if (existsSync(join(home, name))) {
			return join(home, name);
		}
	}
	return join(home, '.bash_profile');
}

/** The user profile of one PowerShell host, asked with `-NoProfile` so nothing of the user's runs (spec SEC-8). */
export function powershellProfile(
	host: 'powershell' | 'pwsh',
	env: NodeJS.ProcessEnv,
): string | null {
	const bin = host === 'powershell' ? powershellPath(env) : 'pwsh';
	try {
		const out = execFileSync(
			bin,
			['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'],
			{
				encoding: 'utf8',
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		).trim();
		return out === '' ? null : out;
	} catch {
		return null;
	}
}

/** The files to edit for `shells` (spec SH-3); PowerShell hosts that are not installed yield nothing. */
export function profileTargets(
	shells: readonly Shell[],
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = env['HOME'] || homedir(),
): ProfileTarget[] {
	const targets: ProfileTarget[] = [];
	for (const shell of shells) {
		switch (shell) {
			case 'zsh': {
				const zdot = env['ZDOTDIR'] || home;
				targets.push({ shell, file: join(zdot, '.zshenv'), parts: { path: true, hook: false } });
				targets.push({ shell, file: join(zdot, '.zshrc'), parts: { path: false, hook: true } });
				break;
			}
			case 'bash': {
				targets.push({ shell, file: join(home, '.bashrc'), parts: { path: true, hook: true } });
				const login = bashLoginFile(home);
				if (login !== join(home, '.bashrc')) {
					targets.push({ shell, file: login, parts: { path: true, hook: false } });
				}
				break;
			}
			case 'fish': {
				const config = env['XDG_CONFIG_HOME'] || join(home, '.config');
				targets.push({
					shell,
					file: join(config, 'fish', 'conf.d', 'npm-use.fish'),
					parts: { path: true, hook: true },
				});
				break;
			}
			case 'powershell': {
				const hosts: Array<'powershell' | 'pwsh'> =
					platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
				for (const host of hosts) {
					const file = powershellProfile(host, env);
					if (file !== null && !targets.some((target) => target.file === file)) {
						targets.push({ shell, file, parts: { path: true, hook: true } });
					}
				}
				break;
			}
		}
	}
	return targets;
}

/** Why a profile is printed instead of edited (spec SH-5), or null when editing it is fine. */
export function profileGuard(
	file: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	let stat;
	try {
		stat = lstatSync(file);
	} catch {
		stat = null;
	}
	if (stat !== null && stat.isSymbolicLink()) {
		return 'it is a symlink, so a dotfile manager probably owns it';
	}
	const probe = stat === null ? dirname(file) : file;
	try {
		accessSync(probe, constants.W_OK);
	} catch {
		return 'it is not writable';
	}
	try {
		if (realpathSync(probe).startsWith('/nix/store')) {
			return 'it lives in the Nix store (home-manager)';
		}
	} catch {
		// An unresolvable path is handled by the write itself.
	}
	const chezmoi = join(env['HOME'] || homedir(), '.local', 'share', 'chezmoi');
	if (existsSync(join(chezmoi, `dot_${basename(file).replace(/^\./, '')}`))) {
		return 'chezmoi manages it';
	}
	if (platform === 'win32' && stat !== null && file.endsWith('.ps1')) {
		const content = readFileSync(file, 'utf8');
		if (content.includes('# SIG # Begin signature block') && executionPolicy(env) === 'AllSigned') {
			return 'it is signed and the execution policy is AllSigned';
		}
	}
	return null;
}

/** The effective PowerShell execution policy, asked without a profile (spec WIN-2). */
export function executionPolicy(env: NodeJS.ProcessEnv = process.env): string | null {
	try {
		return execFileSync(
			powershellPath(env),
			['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
			{
				encoding: 'utf8',
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		).trim();
	} catch {
		return null;
	}
}

export interface ProfileEdit {
	target: ProfileTarget;
	before: string | null;
	after: string;
	/** A diff of the block the edit adds or replaces, for the consent prompt. */
	diff: string;
}

/** The content with our block replaced or appended; a trailing newline is guaranteed before the block. */
export function withBlock(content: string | null, block: string): string {
	const text = content ?? '';
	if (BLOCK_RE.test(text)) {
		return text.replace(BLOCK_RE, block);
	}
	const separator = text === '' || text.endsWith('\n') ? '' : '\n';
	return `${text}${separator}${text === '' ? '' : '\n'}${block}`;
}

/** The content without our block and the blank line that separated it; nothing else moves. */
export function withoutBlock(content: string): string {
	const match = BLOCK_RE.exec(content);
	if (match === null) {
		return content;
	}
	let before = content.slice(0, match.index).replace(/\n+$/, '\n');
	if (before === '\n') {
		before = '';
	}
	const after = content.slice(match.index + match[0].length);
	return before !== '' && after !== '' ? `${before}\n${after}` : `${before}${after}`;
}

export function currentBlock(content: string): string | null {
	const match = BLOCK_RE.exec(content);
	return match === null ? null : match[0];
}

function renderDiff(file: string, before: string | null, after: string): string {
	const oldBlock = before === null ? null : currentBlock(before);
	const newBlock = currentBlock(after) ?? '';
	const lines = [`--- ${file}`, `+++ ${file}`];
	if (oldBlock !== null) {
		lines.push(
			...oldBlock
				.trimEnd()
				.split('\n')
				.map((line) => `-${line}`),
		);
	}
	lines.push(
		...newBlock
			.trimEnd()
			.split('\n')
			.map((line) => `+${line}`),
	);
	return `${lines.join('\n')}\n`;
}

/** What `setup` would write for `target`, or null when the file already holds exactly this block. */
export function planProfileEdit(target: ProfileTarget, home: string): ProfileEdit | null {
	const before = existsSync(target.file) ? readFileSync(target.file, 'utf8') : null;
	const block = profileBlock(target.shell, home, target.parts);
	const after = withBlock(before, block);
	if (before === after) {
		return null;
	}
	return { target, before, after, diff: renderDiff(target.file, before, after) };
}

function uniqueBackup(file: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	let candidate = `${file}.npm-use-backup-${stamp}`;
	let counter = 1;
	while (existsSync(candidate)) {
		candidate = `${file}.npm-use-backup-${stamp}-${counter}`;
		counter += 1;
	}
	return candidate;
}

/** Applies one consented edit under a journal and a unique backup, and records it (spec SH-4). */
export function applyProfileEdit(dirs: Dirs, owner: OwnerRecord, edit: ProfileEdit): ProfileRecord {
	let backup: string | null = null;
	if (edit.before !== null) {
		backup = uniqueBackup(edit.target.file);
		atomicWrite(backup, edit.before, 0o600);
	}
	const mode = edit.before === null ? 0o644 : captureMeta(edit.target.file).mode || 0o644;
	mutateFile(
		dirs.journal,
		'profile',
		owner,
		edit.target.file,
		Buffer.from(edit.after, 'utf8'),
		mode,
	);
	const record: ProfileRecord = {
		file: edit.target.file,
		shell: edit.target.shell,
		parts: edit.target.parts,
		writtenSha256: sha256(edit.after),
		backup,
		updatedAt: new Date().toISOString(),
	};
	const profiles = readProfiles(dirs);
	profiles.entries = [...profiles.entries.filter((entry) => entry.file !== record.file), record];
	writeProfiles(dirs, profiles);
	return record;
}

export type RemoveOutcome = 'removed' | 'changed' | 'missing';

/** Removes our block only when the file is still what we wrote (spec MUT-5); otherwise it is left alone. */
export function removeProfileBlock(
	dirs: Dirs,
	owner: OwnerRecord,
	record: ProfileRecord,
): RemoveOutcome {
	if (!existsSync(record.file)) {
		forget(dirs, record);
		return 'missing';
	}
	const content = readFileSync(record.file, 'utf8');
	if (sha256(content) !== record.writtenSha256) {
		return 'changed';
	}
	const after = withoutBlock(content);
	mutateFile(
		dirs.journal,
		'profile',
		owner,
		record.file,
		after.trim() === '' ? null : Buffer.from(after, 'utf8'),
		captureMeta(record.file).mode || 0o644,
	);
	forget(dirs, record);
	return 'removed';
}

function forget(dirs: Dirs, record: ProfileRecord): void {
	const profiles = readProfiles(dirs);
	profiles.entries = profiles.entries.filter((entry) => entry.file !== record.file);
	writeProfiles(dirs, profiles);
}

export function readProfiles(dirs: Dirs): ProfilesFile {
	try {
		const parsed = JSON.parse(
			readFileSync(join(dirs.state, PROFILES_FILE), 'utf8'),
		) as ProfilesFile;
		return Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
	} catch {
		return { version: 1, entries: [] };
	}
}

export function writeProfiles(dirs: Dirs, profiles: ProfilesFile): void {
	atomicWrite(join(dirs.state, PROFILES_FILE), JSON.stringify(profiles, null, '\t'), 0o600);
}

export { BLOCK_END, BLOCK_START };
