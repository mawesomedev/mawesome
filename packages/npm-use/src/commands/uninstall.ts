import { rmSync } from 'node:fs';
import { EXIT } from '../errors.ts';
import { changedMessage } from '../messages.ts';
import { recoverDeadJournals } from '../state/journal.ts';
import { acquireLock } from '../state/lock.ts';
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
}

export async function uninstall(
	context: CommandContext,
	options: UninstallOptions,
): Promise<number> {
	const { dirs, env, platform, io } = context;
	if (!options.yes) {
		const agreed = await io.confirm(
			`Remove npm-use from ${dirs.home}, its profile blocks and links${options.purgeCache ? ', and the cache' : ''}?`,
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
				io.err(changedMessage(entry.file, 'npm-use block'));
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
		// Still under the lock, so a concurrent setup cannot start writing into a home being deleted.
		rmSync(dirs.home, { recursive: true, force: true });
		report.homeRemoved = true;
	} finally {
		lock.release();
	}
	if (options.purgeCache) {
		rmSync(dirs.cache, { recursive: true, force: true });
		report.cacheRemoved = true;
	}
	io.out(context.json ? JSON.stringify(report, null, 2) : describe(report, dirs.cache));
	return clean ? EXIT.ok : EXIT.problems;
}

function describe(report: UninstallReport, cache: string): string {
	const lines = ['npm-use removed.'];
	for (const profile of report.profiles) {
		lines.push(`  ${profile.file}: ${profile.outcome}`);
	}
	for (const link of report.links) {
		lines.push(`  ${link.target}: ${link.outcome}`);
	}
	lines.push(
		report.cacheRemoved
			? `  cache removed (${cache})`
			: `  cache kept at ${cache}; add --purge-cache to remove it`,
	);
	return lines.join('\n');
}
