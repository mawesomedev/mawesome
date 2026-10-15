import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sriHex, type Candidate } from '../select.ts';
import { createLease, newToken, type Lease, type OwnerRecord } from '../state/lease.ts';
import { readVerified } from './verify.ts';

export const ENTRIES_DIR = 'npm';

/** `<version>-<16 hex of the integrity>`: two registries serving different bytes get two entries (spec SEC-4). */
export function entryName(version: string, integrity: string): string {
	const hex = sriHex(integrity);
	if (hex === null) {
		throw new Error(`not a sha512 integrity: ${integrity}`);
	}
	return `${version}-${hex.slice(0, 16)}`;
}

export function canonicalEntry(cacheRoot: string, version: string, integrity: string): string {
	return join(cacheRoot, ENTRIES_DIR, entryName(version, integrity));
}

export function privateEntry(canonical: string, token: string): string {
	return `${canonical}.${token}`;
}

/** Whether a directory name under `npm/` is an entry rather than a lease dir, a gate or a deletion in progress. */
export function isEntryName(name: string): boolean {
	return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{16}(?:\.[0-9a-f]{16})?$/.test(name);
}

function readManifest(
	dir: string,
): { name: unknown; version: unknown; enginesNode: string | null } | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
			string,
			unknown
		>;
		const engines = pkg['engines'];
		const node =
			typeof engines === 'object' && engines !== null
				? (engines as Record<string, unknown>)['node']
				: undefined;
		return {
			name: pkg['name'],
			version: pkg['version'],
			enginesNode: typeof node === 'string' ? node : null,
		};
	} catch {
		return null;
	}
}

/**
 * Whether an entry may run (spec SEC-5): verified for this integrity, owned by the current user,
 * and holding the npm it claims. Never deletes anything.
 */
export function validateEntry(entryPath: string, integrity: string): boolean {
	try {
		const stat = statSync(entryPath);
		if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
			return false;
		}
	} catch {
		return false;
	}
	const verified = readVerified(entryPath);
	if (verified === null || verified.integrity !== integrity) {
		return false;
	}
	const manifest = readManifest(entryPath);
	return manifest !== null && manifest.name === 'npm' && manifest.version === verified.version;
}

/** Every verified entry in the cache as a candidate, whatever its validity; use-time validation decides. */
export function listEntries(cacheRoot: string): Candidate[] {
	let names: string[];
	try {
		names = readdirSync(join(cacheRoot, ENTRIES_DIR));
	} catch {
		return [];
	}
	const candidates: Candidate[] = [];
	for (const name of names) {
		if (!isEntryName(name)) {
			continue;
		}
		const entryPath = join(cacheRoot, ENTRIES_DIR, name);
		const verified = readVerified(entryPath);
		const manifest = readManifest(entryPath);
		if (verified === null || manifest === null || manifest.version !== verified.version) {
			continue;
		}
		candidates.push({
			version: verified.version,
			enginesNode: manifest.enginesNode,
			integrity: verified.integrity,
			entryPath,
			signatures: null,
		});
	}
	return candidates;
}

export interface PublishedEntry {
	entryPath: string;
	lease: Lease;
}

function isCollision(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EISDIR';
}

/**
 * Moves a verified temp dir into the cache under a lease (spec SEC-4). The lease exists before the
 * rename, so a prune never sees the entry without it; a lost race reuses or sidesteps the winner's entry.
 */
export function publishEntry(
	tempDir: string,
	canonical: string,
	integrity: string,
	owner: OwnerRecord,
): PublishedEntry {
	const lease = createLease(canonical, owner);
	try {
		renameSync(tempDir, canonical);
		return { entryPath: canonical, lease };
	} catch (error) {
		lease.release();
		if (!isCollision(error)) {
			throw error;
		}
	}
	if (validateEntry(canonical, integrity)) {
		const shared = createLease(canonical, owner);
		rmSync(tempDir, { recursive: true, force: true });
		return { entryPath: canonical, lease: shared };
	}
	const entryPath = privateEntry(canonical, newToken());
	const privateLease = createLease(entryPath, owner);
	try {
		renameSync(tempDir, entryPath);
	} catch (error) {
		privateLease.release();
		throw error;
	}
	return { entryPath, lease: privateLease };
}
