import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { atomicWrite, withSharingRetry } from '../state/atomic.ts';
import { mutateFile } from '../state/journal.ts';
import type { OwnerRecord } from '../state/lease.ts';
import { captureMeta, metaMatches, type Meta } from '../state/meta.ts';
import type { Dirs } from './home.ts';
import { cmdShim, posixShim, powershellShim, type ShimName } from './shims.ts';

export type NodeManager = 'nvm' | 'fnm' | 'nvm-windows';

/** One Node install whose `npm` and `npx` entry points `--link` replaces (spec LNK-1). */
export interface NodeInstall {
	manager: NodeManager;
	version: string;
	binDir: string;
}

export const ORIGINAL_SUFFIX = '.npm-use-original';
export const LINKS_FILE = 'links.json';

export interface LinkRecord {
	binDir: string;
	/** The entry point we replaced, e.g. `npm` or `npm.cmd`. */
	name: string;
	target: string;
	originalPath: string | null;
	original: Meta;
	shim: Meta;
	linkedAt: string;
}

export interface LinksFile {
	version: 1;
	entries: LinkRecord[];
}

function versionsUnder(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => /^v?\d+\.\d+\.\d+$/.test(name));
	} catch {
		return [];
	}
}

function fnmDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
	if (env['FNM_DIR']) {
		return env['FNM_DIR'];
	}
	if (platform === 'win32') {
		return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'fnm');
	}
	if (platform === 'darwin') {
		return join(home, 'Library', 'Application Support', 'fnm');
	}
	return join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'fnm');
}

/** The root nvm-windows keeps its versions in, from its settings.txt (spec LNK-1). */
function nvmWindowsRoot(env: NodeJS.ProcessEnv): string | null {
	const nvmHome = env['NVM_HOME'];
	if (!nvmHome) {
		return null;
	}
	try {
		const settings = readFileSync(join(nvmHome, 'settings.txt'), 'utf8');
		const root = /^root:\s*(.+)$/m.exec(settings)?.[1]?.trim();
		return root ?? nvmHome;
	} catch {
		return nvmHome;
	}
}

/** Windows paths resolved through junctions and compared without case, so one install is never linked twice (LNK-4). */
export function installKey(binDir: string, platform: NodeJS.Platform): string {
	let real = binDir;
	try {
		real = realpathSync(binDir);
	} catch {
		// A missing dir is listed as given and skipped as unwritable later.
	}
	return platform === 'win32' ? real.toLowerCase() : real;
}

export function findNodeInstalls(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = env['HOME'] || homedir(),
): NodeInstall[] {
	const installs: NodeInstall[] = [];
	const seen = new Set<string>();
	const add = (install: NodeInstall): void => {
		const key = installKey(install.binDir, platform);
		if (!seen.has(key) && existsSync(install.binDir)) {
			seen.add(key);
			installs.push(install);
		}
	};
	const nvmDir = env['NVM_DIR'] || join(home, '.nvm');
	for (const version of versionsUnder(join(nvmDir, 'versions', 'node'))) {
		add({
			manager: 'nvm',
			version: version.replace(/^v/, ''),
			binDir: join(nvmDir, 'versions', 'node', version, 'bin'),
		});
	}
	const fnm = join(fnmDir(env, platform, home), 'node-versions');
	for (const version of versionsUnder(fnm)) {
		const installation = join(fnm, version, 'installation');
		add({
			manager: 'fnm',
			version: version.replace(/^v/, ''),
			binDir: platform === 'win32' ? installation : join(installation, 'bin'),
		});
	}
	if (platform === 'win32') {
		const root = nvmWindowsRoot(env);
		if (root !== null) {
			for (const version of versionsUnder(root)) {
				add({
					manager: 'nvm-windows',
					version: version.replace(/^v/, ''),
					binDir: join(root, version),
				});
			}
		}
	}
	return installs;
}

/** The files `--link` replaces in one install, with the shim content each gets. */
export function linkTargets(
	binDir: string,
	home: string,
	platform: NodeJS.Platform,
	powershell: boolean,
): Array<{ name: string; content: string; mode: number }> {
	const targets: Array<{ name: string; content: string; mode: number }> = [];
	for (const name of ['npm', 'npx'] as const satisfies readonly ShimName[]) {
		targets.push({ name, content: posixShim(home, name), mode: 0o755 });
		if (platform === 'win32') {
			targets.push({ name: `${name}.cmd`, content: cmdShim(home, name), mode: 0o644 });
			if (powershell) {
				targets.push({ name: `${name}.ps1`, content: powershellShim(home, name), mode: 0o644 });
			}
		}
	}
	void binDir;
	return targets;
}

export type LinkOutcome = 'linked' | 'already' | 'foreign' | 'unwritable' | 'missing';

export interface LinkResult {
	target: string;
	outcome: LinkOutcome;
	detail?: string;
}

function isOurShim(content: string, expected: string): boolean {
	return content === expected;
}

/**
 * Replaces one entry point with a shim (spec LNK-2, LNK-3): the original is renamed beside it and both are
 * recorded. A file matching neither our shim nor a known original is reported and left alone.
 */
export function linkOne(
	dirs: Dirs,
	owner: OwnerRecord,
	binDir: string,
	target: { name: string; content: string; mode: number },
): LinkResult {
	const path = join(binDir, target.name);
	const records = readLinks(dirs);
	const known = records.entries.find((entry) => entry.target === path);
	const current = captureMeta(path);
	if (current.type === 'missing') {
		return { target: path, outcome: 'missing' };
	}
	if (current.type === 'file' && isOurShim(readFileSync(path, 'utf8'), target.content)) {
		if (known === undefined) {
			record(dirs, {
				binDir,
				name: target.name,
				target: path,
				originalPath: existsSync(`${path}${ORIGINAL_SUFFIX}`) ? `${path}${ORIGINAL_SUFFIX}` : null,
				original: captureMeta(`${path}${ORIGINAL_SUFFIX}`),
				shim: current,
				linkedAt: new Date().toISOString(),
			});
		}
		return { target: path, outcome: 'already' };
	}
	if (known !== undefined && !metaMatches(path, known.original) && !metaMatches(path, known.shim)) {
		return { target: path, outcome: 'foreign', detail: 'changed since npm-use linked it' };
	}
	const originalPath = `${path}${ORIGINAL_SUFFIX}`;
	if (
		existsSync(originalPath) &&
		(known === undefined || !metaMatches(originalPath, known.original))
	) {
		return { target: path, outcome: 'foreign', detail: `${originalPath} already exists` };
	}
	try {
		withSharingRetry(() => renameSync(path, originalPath));
	} catch (error) {
		return { target: path, outcome: 'unwritable', detail: (error as Error).message };
	}
	mutateFile(dirs.journal, 'link', owner, path, Buffer.from(target.content, 'utf8'), target.mode);
	record(dirs, {
		binDir,
		name: target.name,
		target: path,
		originalPath,
		original: current,
		shim: captureMeta(path),
		linkedAt: new Date().toISOString(),
	});
	return { target: path, outcome: 'linked' };
}

export type UnlinkOutcome = 'restored' | 'changed' | 'missing';

/** Puts the original back only when the shim is still ours (spec MUT-5); a replaced file is left as is. */
export function unlinkOne(dirs: Dirs, owner: OwnerRecord, entry: LinkRecord): UnlinkOutcome {
	const current = captureMeta(entry.target);
	if (current.type === 'missing') {
		forget(dirs, entry);
		return 'missing';
	}
	if (!metaMatches(entry.target, entry.shim)) {
		return 'changed';
	}
	if (entry.originalPath !== null && existsSync(entry.originalPath)) {
		mutateFile(dirs.journal, 'link', owner, entry.target, null);
		withSharingRetry(() => renameSync(entry.originalPath as string, entry.target));
	} else {
		mutateFile(dirs.journal, 'link', owner, entry.target, null);
	}
	forget(dirs, entry);
	return 'restored';
}

function record(dirs: Dirs, entry: LinkRecord): void {
	const links = readLinks(dirs);
	links.entries = [...links.entries.filter((item) => item.target !== entry.target), entry];
	writeLinks(dirs, links);
}

function forget(dirs: Dirs, entry: LinkRecord): void {
	const links = readLinks(dirs);
	links.entries = links.entries.filter((item) => item.target !== entry.target);
	writeLinks(dirs, links);
}

export function readLinks(dirs: Dirs): LinksFile {
	try {
		const parsed = JSON.parse(readFileSync(join(dirs.state, LINKS_FILE), 'utf8')) as LinksFile;
		return Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
	} catch {
		return { version: 1, entries: [] };
	}
}

export function writeLinks(dirs: Dirs, links: LinksFile): void {
	atomicWrite(join(dirs.state, LINKS_FILE), JSON.stringify(links, null, '\t'), 0o600);
}

/** Whether a recorded link still holds our shim, for `doctor` (spec CLI). */
export function linkState(entry: LinkRecord): 'intact' | 'changed' | 'missing' {
	const type = captureMeta(entry.target).type;
	if (type === 'missing') {
		return 'missing';
	}
	return metaMatches(entry.target, entry.shim) ? 'intact' : 'changed';
}

export function describeInstall(install: NodeInstall): string {
	return `${install.manager} ${install.version} (${install.binDir})`;
}

export function isSymlinkTo(path: string, suffix: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink() && basename(dirname(path)) === suffix;
	} catch {
		return false;
	}
}
