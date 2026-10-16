import { rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicRename, removeWithRetry } from '../state/atomic.ts';
import { EXIT } from '../errors.ts';
import { ENTRIES_DIR, stagingDir } from '../install/cache.ts';
import { changedMessage } from '../messages.ts';
import { recoverDeadJournals } from '../state/journal.ts';
import { acquireLock } from '../state/lock.ts';
import { pruneCache } from '../state/prune.ts';
import { readLinks, unlinkOne } from '../setup/link.ts';
import { readProfiles, removeProfileBlock } from '../setup/profile.ts';
import { shimDir } from '../setup/shims.ts';
import { clearCmdAutoRun, removeFromUserPath } from '../setup/windows.ts';
import type { CommandContext } from './context.ts';

export interface UninstallOptions {
	yes: boolean;
	purgeCache: boolean;
}

export interface UninstallReport {
	profiles: Array<{ file: string; outcome: string }>;
	links: Array<{ target: string; outcome: string }>;
	homeRemoved: boolean;
	cacheRemoved: boolean;
	/** Entries `--purge-cache` left because a running npm holds them. */
	cacheKept: string[];
}

/** Removes the cache's directories only while empty: an npm publishing right now keeps its entry. */
function removeEmptyTree(cache: string): void {
	for (const dir of [join(cache, ENTRIES_DIR), stagingDir(cache), cache]) {
		try {
			rmdirSync(dir);
		} catch {
			// Not empty or already gone; either way it stays as it is.
		}
	}
}

export async function uninstall(
	context: CommandContext,
	options: UninstallOptions,
): Promise<number> {
	const { dirs, env, platform, io } = context;
	if (!options.yes) {
		const agreed = await io.confirm(
			`Remove npm-vm from ${dirs.home}, its profile blocks and links${options.purgeCache ? ', and the cache' : ''}?`,
		);
		if (!agreed) {
			io.out('Nothing removed.');
			return EXIT.ok;
		}
	}
	const report: UninstallReport = {
		profiles: [],
		links: [],
		homeRemoved: false,
		cacheRemoved: false,
		cacheKept: [],
	};
	const lock = await acquireLock(dirs.state, context.owner);
	let clean = true;
	try {
		recoverDeadJournals(dirs.journal, dirs.machine.id);
		for (const entry of readProfiles(dirs).entries) {
			const outcome = removeProfileBlock(dirs, context.owner, entry);
			report.profiles.push({ file: entry.file, outcome });
			if (outcome === 'changed') {
				clean = false;
				io.err(changedMessage(entry.file, 'npm-vm block'));
			}
		}
		for (const entry of readLinks(dirs).entries) {
			const outcome = unlinkOne(dirs, context.owner, entry);
			report.links.push({ target: entry.target, outcome });
			if (outcome === 'changed') {
				clean = false;
				io.err(changedMessage(entry.target, 'shim'));
			}
		}
		if (platform === 'win32') {
			removeFromUserPath(env, shimDir(dirs.home));
			clearCmdAutoRun(env);
		}
		if (options.purgeCache) {
			// Through the gate and lease protocol, under the home lock and the cache's own lock, which other homes share.
			const cacheLock = await acquireLock(dirs.cache, context.owner);
			try {
				const pruned = pruneCache(dirs.cache, context.owner, { maxAgeMs: 0 });
				report.cacheKept = pruned.kept.concat(pruned.skipped);
				if (report.cacheKept.length === 0) {
					removeEmptyTree(dirs.cache);
					report.cacheRemoved = true;
				}
			} finally {
				cacheLock.release();
			}
			if (report.cacheRemoved) {
				// The lock file itself kept the root; now it can go too.
				removeEmptyTree(dirs.cache);
			}
			if (report.cacheKept.length > 0) {
				clean = false;
				io.err(
					`Cache kept: ${report.cacheKept.join(', ')} ${report.cacheKept.length === 1 ? 'is' : 'are'} in use by a running npm.`,
				);
			}
		}
		// Under the lock the home moves aside in one rename, so a setup that follows never writes into a dir being deleted.
		const tombstone = `${dirs.home}.removing.${process.pid}.${Date.now()}`;
		atomicRename(dirs.home, tombstone);
		removeWithRetry(tombstone);
		report.homeRemoved = true;
	} finally {
		lock.release();
	}
	io.out(context.json ? JSON.stringify(report, null, 2) : describe(report, dirs.cache));
	return clean ? EXIT.ok : EXIT.problems;
}

function describe(report: UninstallReport, cache: string): string {
	const lines = ['npm-vm removed.'];
	for (const profile of report.profiles) {
		lines.push(`  ${profile.file}: ${profile.outcome}`);
	}
	for (const link of report.links) {
		lines.push(`  ${link.target}: ${link.outcome}`);
	}
	if (report.cacheRemoved) {
		lines.push(`  cache removed (${cache})`);
	} else if (report.cacheKept.length > 0) {
		lines.push(`  cache kept at ${cache}: ${report.cacheKept.join(', ')} in use by a running npm`);
	} else {
		lines.push(`  cache kept at ${cache}; add --purge-cache to remove it`);
	}
	return lines.join('\n');
}
