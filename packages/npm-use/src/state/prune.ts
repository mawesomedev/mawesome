import { existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRIES_DIR, isEntryName, validateEntry } from '../install/cache.ts';
import { readVerified } from '../install/verify.ts';
import { atomicRename, removeWithRetry } from './atomic.ts';
import {
	createGate,
	gatePath,
	leasesDir,
	listLeases,
	newToken,
	ownerLive,
	removeGate,
	type OwnerRecord,
} from './lease.ts';

export const USED_SUFFIX = '.used';

/** Records a resolution of `entry` for the prune age, in a sidecar so the entry itself stays untouched. */
export function touchUsed(entry: string): void {
	const marker = `${entry}${USED_SUFFIX}`;
	try {
		const now = new Date();
		utimesSync(marker, now, now);
	} catch {
		writeFileSync(marker, '', { flag: 'a' });
	}
}

export function lastUsed(entry: string): number | null {
	try {
		return statSync(`${entry}${USED_SUFFIX}`).mtimeMs;
	} catch {
		return null;
	}
}

export interface PruneOptions {
	/** Entries not resolved for this long are removed; `Infinity` keeps every valid entry. */
	maxAgeMs: number;
	now?: number;
}

export interface PruneReport {
	removed: string[];
	kept: string[];
	skipped: string[];
}

export type PruneReason = 'stale' | 'invalid' | 'orphan-private' | 'leftover';

/** Why one entry would go, or null to keep it. */
export function pruneReason(
	cacheRoot: string,
	name: string,
	options: PruneOptions,
): PruneReason | null {
	const entry = join(cacheRoot, ENTRIES_DIR, name);
	if (name.includes('.deleting.')) {
		return 'leftover';
	}
	if (!isEntryName(name)) {
		return null;
	}
	const verified = readVerified(entry);
	if (verified === null || !validateEntry(entry, verified.integrity)) {
		return 'invalid';
	}
	const isPrivate = /\.[0-9a-f]{16}$/.test(name);
	if (isPrivate && !listLeases(entry).some((lease) => ownerLive(lease))) {
		return 'orphan-private';
	}
	const used = lastUsed(entry);
	const age = (options.now ?? Date.now()) - (used ?? statSync(entry).mtimeMs);
	return age > options.maxAgeMs ? 'stale' : null;
}

/**
 * Removes one entry the exclusive way (spec LEASE-1): gate, drop dead leases, bail on a live one, rename aside, drop the gate, delete.
 * After the gate is gone nothing here touches the entry's paths again.
 */
export function pruneEntry(entry: string, owner: OwnerRecord): boolean {
	if (existsSync(gatePath(entry)) && !ownerLive(gatePath(entry))) {
		removeGate(entry);
	}
	if (!createGate(entry, owner)) {
		return false;
	}
	for (const lease of listLeases(entry)) {
		if (!ownerLive(lease)) {
			rmSync(lease, { force: true });
		}
	}
	if (listLeases(entry).length > 0) {
		removeGate(entry);
		return false;
	}
	const token = newToken();
	const deletingEntry = `${entry}.deleting.${token}`;
	const deletingLeases = `${entry}.leases.deleting.${token}`;
	if (existsSync(entry)) {
		atomicRename(entry, deletingEntry);
	}
	if (existsSync(leasesDir(entry))) {
		atomicRename(leasesDir(entry), deletingLeases);
	}
	removeGate(entry);
	removeWithRetry(deletingEntry);
	removeWithRetry(deletingLeases);
	rmSync(`${entry}${USED_SUFFIX}`, { force: true });
	return true;
}

/** Prunes the whole cache; the caller holds the exclusive lock (MUT-1) so only one prune ever runs. */
export function pruneCache(
	cacheRoot: string,
	owner: OwnerRecord,
	options: PruneOptions,
): PruneReport {
	const report: PruneReport = { removed: [], kept: [], skipped: [] };
	let names: string[];
	try {
		names = readdirSync(join(cacheRoot, ENTRIES_DIR));
	} catch {
		return report;
	}
	for (const name of names) {
		const entry = join(cacheRoot, ENTRIES_DIR, name);
		// A lease dir whose entry is gone and whose owners are all dead is a crashed prune's leftover too.
		if (name.endsWith('.leases') && !existsSync(entry.slice(0, -'.leases'.length))) {
			// Through the gate like any entry: a publisher creating its lease right now still wins.
			pruneEntry(entry.slice(0, -'.leases'.length), owner);
			continue;
		}
		// A gate whose entry is gone and whose owner is dead is a crashed prune's leftover.
		if (
			name.endsWith('.prune') &&
			!existsSync(entry.slice(0, -'.prune'.length)) &&
			!ownerLive(entry)
		) {
			rmSync(entry, { force: true });
			report.removed.push(name);
			continue;
		}
		const reason = pruneReason(cacheRoot, name, options);
		if (reason === null) {
			if (isEntryName(name)) {
				report.kept.push(name);
			}
			continue;
		}
		if (reason === 'leftover') {
			removeWithRetry(entry);
			report.removed.push(name);
			continue;
		}
		if (pruneEntry(entry, owner)) {
			report.removed.push(name);
		} else {
			report.skipped.push(name);
		}
	}
	return report;
}
