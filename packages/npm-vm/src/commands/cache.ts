import { EXIT, NpmVmError } from '../errors.ts';
import { resolveNpmWith } from '../index.ts';
import { listEntries } from '../install/cache.ts';
import { createContext, createInstaller } from '../install/index.ts';
import { readVerified } from '../install/verify.ts';
import { listJournals, recoverDeadJournals, recoverForeignJournal } from '../state/journal.ts';
import { listLeases, ownerLive } from '../state/lease.ts';
import { acquireLock } from '../state/lock.ts';
import { isLive } from '../state/proc.ts';
import { lastUsed, pruneCache } from '../state/prune.ts';
import type { CommandContext } from './context.ts';

const DAY_MS = 86_400_000;
export const DEFAULT_PRUNE_DAYS = 90;

/** `install [<spec>]`: fetches and verifies the project's npm, or the given spec, into the cache. */
export async function install(
	context: CommandContext,
	spec: string | undefined,
	cwd: string = process.cwd(),
): Promise<number> {
	const env = spec === undefined ? context.env : { ...context.env, NPM_VM_VERSION: spec };
	const installer = createInstaller(createContext(env, context.dirs.home));
	const result = await resolveNpmWith([], cwd, { env }, installer);
	if (result.selection === null) {
		context.io.out(
			context.json
				? JSON.stringify(result)
				: `Node's own npm ${result.version} satisfies the requirement; nothing to download.`,
		);
		return EXIT.ok;
	}
	const ensured = await installer.ensure(result.selection);
	ensured.lease.release();
	context.io.out(
		context.json
			? JSON.stringify({ ...result, entryPath: ensured.entryPath })
			: `npm ${result.version} is ready in ${ensured.entryPath}`,
	);
	return EXIT.ok;
}

export interface CacheEntryView {
	version: string;
	integrity: string;
	path: string;
	lastUsed: string | null;
	liveLeases: number;
	verifiedAt: string;
}

export function cacheList(context: CommandContext): number {
	const entries: CacheEntryView[] = listEntries(context.dirs.cache).map((entry) => {
		const used = lastUsed(entry.entryPath as string);
		return {
			version: entry.version,
			integrity: entry.integrity,
			path: entry.entryPath as string,
			lastUsed: used === null ? null : new Date(used).toISOString(),
			liveLeases: listLeases(entry.entryPath as string).filter((lease) => ownerLive(lease)).length,
			verifiedAt: readVerified(entry.entryPath as string)?.verifiedAt ?? '',
		};
	});
	if (context.json) {
		context.io.out(JSON.stringify({ cache: context.dirs.cache, entries }, null, 2));
	} else {
		const lines = [`${context.dirs.cache}`];
		for (const entry of entries) {
			lines.push(
				`  npm ${entry.version}  ${entry.path}  last used ${entry.lastUsed ?? 'never'}${entry.liveLeases > 0 ? `  in use by ${entry.liveLeases}` : ''}`,
			);
		}
		if (entries.length === 0) {
			lines.push('  (empty)');
		}
		context.io.out(lines.join('\n'));
	}
	return EXIT.ok;
}

export async function cachePrune(
	context: CommandContext,
	olderThanDays: number = DEFAULT_PRUNE_DAYS,
): Promise<number> {
	if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
		throw new NpmVmError(
			'M-NOMATCH',
			EXIT.usage,
			'--older-than needs a non-negative number of days.',
		);
	}
	const lock = await acquireLock(context.dirs.state, context.owner);
	try {
		recoverDeadJournals(context.dirs.journal, context.dirs.machine.id);
		const report = pruneCache(context.dirs.cache, context.owner, {
			maxAgeMs: olderThanDays * DAY_MS,
		});
		context.io.out(
			context.json
				? JSON.stringify(report, null, 2)
				: `Removed ${report.removed.length}, kept ${report.kept.length}, skipped ${report.skipped.length} (in use).`,
		);
	} finally {
		lock.release();
	}
	return EXIT.ok;
}

/** `recover --journal <id> --confirm-dead-machine <machine-id>` (spec PROC-1, CLI). */
export async function recover(
	context: CommandContext,
	journalId: string,
	confirmedMachine: string,
): Promise<number> {
	const journal = listJournals(context.dirs.journal).find((entry) => entry.id === journalId);
	if (journal === undefined) {
		throw new NpmVmError(
			'M-NOMATCH',
			EXIT.usage,
			`No journal ${journalId} under ${context.dirs.journal}.`,
		);
	}
	if (journal.owner.machineId !== confirmedMachine) {
		throw new NpmVmError(
			'M-NOMATCH',
			EXIT.usage,
			`Journal ${journalId} belongs to machine ${journal.owner.machineId}, not ${confirmedMachine}.`,
		);
	}
	if (journal.owner.machineId === context.dirs.machine.id && isLive(journal.owner)) {
		throw new NpmVmError(
			'M-LOCKED',
			EXIT.problems,
			`Journal ${journalId} belongs to PID ${journal.owner.pid} on this machine, which is still running.`,
		);
	}
	const lock = await acquireLock(context.dirs.state, context.owner);
	try {
		const report = recoverForeignJournal(context.dirs.journal, journalId, confirmedMachine);
		context.io.out(
			context.json ? JSON.stringify(report) : `Recovered ${journalId}: ${describeReport(report)}`,
		);
	} finally {
		lock.release();
	}
	return EXIT.ok;
}

function describeReport(report: {
	finished: string[];
	replayed: string[];
	rolledBack: string[];
	changed: string[];
}): string {
	if (report.replayed.length > 0) {
		return 'replayed';
	}
	if (report.rolledBack.length > 0) {
		return 'rolled back';
	}
	if (report.changed.length > 0) {
		return 'target changed since, left untouched';
	}
	return 'already finished';
}
