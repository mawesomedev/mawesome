import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const BOOTSTRAP_FILE = 'bootstrap.cjs';
export const RUNTIME_FILE = 'runtime.cjs';
export const CURRENT_FILE = 'current';
export const MANIFEST_FILE = 'manifest.json';

export interface VersionManifest {
	version: string;
	abi: number;
	files: string[];
}

/** Where a runtime build lives: `runtime.cjs`, its chunks and `bootstrap.cjs` side by side. */
export function runtimeDistDir(): string {
	return join(import.meta.dirname, 'runtime');
}

function copyTree(from: string, to: string, files: string[], prefix = ''): void {
	mkdirSync(to, { recursive: true, mode: 0o755 });
	for (const name of readdirSync(from)) {
		const source = join(from, name);
		const target = join(to, name);
		if (statSync(source).isDirectory()) {
			copyTree(source, target, files, `${prefix}${name}/`);
		} else {
			copyFileSync(source, target);
			files.push(`${prefix}${name}`);
		}
	}
}

/**
 * Installs one runtime version under `versions/<version>/` atomically (spec SET-1): copied into a
 * temp dir beside it and renamed into place, so a crash never leaves a half-written version.
 */
export function installVersion(
	home: string,
	version: string,
	distDir: string,
	abi: number,
): string {
	const versions = join(home, 'versions');
	mkdirSync(versions, { recursive: true, mode: 0o755 });
	const target = join(versions, version);
	const staging = join(versions, `.${version}.${process.pid}.${Date.now()}`);
	rmSync(staging, { recursive: true, force: true });
	const files: string[] = [];
	copyTree(distDir, staging, files);
	const manifest: VersionManifest = { version, abi, files: files.toSorted() };
	writeFileSync(join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, '\t'));
	rmSync(target, { recursive: true, force: true });
	renameSync(staging, target);
	return target;
}

/** Points `current` at an installed version; the write is atomic so a launcher never reads a partial file. */
export function setCurrent(home: string, version: string): void {
	const temp = join(home, `.current.${process.pid}.${Date.now()}`);
	writeFileSync(temp, `${version}\n`);
	renameSync(temp, join(home, CURRENT_FILE));
}

export function readCurrent(home: string): string | null {
	try {
		return readFileSync(join(home, CURRENT_FILE), 'utf8').trim();
	} catch {
		return null;
	}
}

/** Copies the launcher entry of an installed version to the home root, where the shims point. */
export function installBootstrap(home: string, version: string): void {
	const source = join(home, 'versions', version, BOOTSTRAP_FILE);
	const temp = join(home, `.${BOOTSTRAP_FILE}.${process.pid}.${Date.now()}`);
	copyFileSync(source, temp);
	renameSync(temp, join(home, BOOTSTRAP_FILE));
}

export function readManifest(home: string, version: string): VersionManifest | null {
	try {
		return JSON.parse(
			readFileSync(join(home, 'versions', version, MANIFEST_FILE), 'utf8'),
		) as VersionManifest;
	} catch {
		return null;
	}
}
