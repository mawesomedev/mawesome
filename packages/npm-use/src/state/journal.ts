import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, removeWithRetry, withSharingRetry } from './atomic.ts';
import { newToken, type OwnerRecord } from './lease.ts';
import { captureMeta, metaMatches, sha256, type Meta } from './meta.ts';
import { isLive } from './proc.ts';

export type JournalKind = 'launcher' | 'profile' | 'link' | 'home';

/** A pending change to one file (spec MUT-2): enough to finish it or undo it after a crash. */
export interface Journal {
	id: string;
	kind: JournalKind;
	owner: OwnerRecord;
	target: string;
	original: Meta;
	/** The sha256 the target will have, or null when the change deletes it. */
	intended: string | null;
	/** Staged copy of the new content, beside the journal. */
	staged: string | null;
	/** Backup of the original content, beside the journal; null when there was none. */
	backup: string | null;
	mode: number;
	createdAt: string;
}

export interface RecoveryReport {
	finished: string[];
	replayed: string[];
	rolledBack: string[];
	changed: string[];
	skipped: string[];
}

export function journalPath(journalDir: string, id: string): string {
	return join(journalDir, `${id}.json`);
}

export function readJournal(file: string): Journal | null {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as Journal;
		return typeof parsed.id === 'string' && typeof parsed.target === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

export function listJournals(journalDir: string): Journal[] {
	let names: string[];
	try {
		names = readdirSync(journalDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith('.json'))
		.map((name) => readJournal(join(journalDir, name)))
		.filter((journal): journal is Journal => journal !== null);
}

export function hasJournals(journalDir: string): boolean {
	return listJournals(journalDir).length > 0;
}

/**
 * Applies one file change under a journal: backup and staged copy first, the journal, then the write.
 * The journal and its sidecars disappear only after the target holds the intended bytes.
 */
export function mutateFile(
	journalDir: string,
	kind: JournalKind,
	owner: OwnerRecord,
	target: string,
	content: Buffer | null,
	mode = 0o644,
): void {
	mkdirSync(journalDir, { recursive: true, mode: 0o700 });
	const id = `${kind}-${newToken()}`;
	const original = captureMeta(target);
	let backup: string | null = null;
	if (original.type === 'file') {
		backup = join(journalDir, `${id}.bak`);
		copyFileSync(target, backup);
	}
	let staged: string | null = null;
	if (content !== null) {
		staged = join(journalDir, `${id}.new`);
		atomicWrite(staged, content, 0o600);
	}
	const journal: Journal = {
		id,
		kind,
		owner,
		target,
		original,
		intended: content === null ? null : sha256(content),
		staged,
		backup,
		mode,
		createdAt: new Date().toISOString(),
	};
	atomicWrite(journalPath(journalDir, id), JSON.stringify(journal), 0o600);
	apply(journal, content);
	discard(journalDir, journal);
}

function apply(journal: Journal, content: Buffer | null): void {
	if (content === null) {
		withSharingRetry(() => {
			if (existsSync(journal.target)) {
				unlinkSync(journal.target);
			}
		});
		return;
	}
	atomicWrite(journal.target, content, journal.mode);
}

function discard(journalDir: string, journal: Journal): void {
	for (const sidecar of [journal.backup, journal.staged]) {
		if (sidecar !== null) {
			rmSync(sidecar, { force: true });
		}
	}
	rmSync(journalPath(journalDir, journal.id), { force: true });
}

function targetSha(target: string): string | null {
	const meta = captureMeta(target);
	return meta.type === 'file' ? meta.sha256 : null;
}

/**
 * Finishes or undoes one journal (spec MUT-2): a target already at the intended bytes is done; one still at the
 * original is replayed from the staged copy; anything else is left alone and reported as changed (MUT-5).
 */
export function recoverJournal(journalDir: string, journal: Journal, report: RecoveryReport): void {
	const current = targetSha(journal.target);
	const exists = captureMeta(journal.target).type !== 'missing';
	if (journal.intended === null ? !exists : current === journal.intended) {
		discard(journalDir, journal);
		report.finished.push(journal.id);
		return;
	}
	if (metaMatches(journal.target, journal.original)) {
		if (journal.intended === null) {
			apply(journal, null);
			report.replayed.push(journal.id);
		} else if (
			journal.staged !== null &&
			existsSync(journal.staged) &&
			sha256(readFileSync(journal.staged)) === journal.intended
		) {
			apply(journal, readFileSync(journal.staged));
			report.replayed.push(journal.id);
		} else {
			// Nothing to replay from, and the target is untouched: the change simply never happened.
			report.rolledBack.push(journal.id);
		}
		discard(journalDir, journal);
		return;
	}
	if (
		journal.backup !== null &&
		existsSync(journal.backup) &&
		journal.original.sha256 === sha256(readFileSync(journal.backup))
	) {
		// A partial or interrupted write: put the original back.
		if (current === null || current !== journal.intended) {
			atomicWrite(
				journal.target,
				readFileSync(journal.backup),
				journal.original.mode || journal.mode,
			);
			report.rolledBack.push(journal.id);
			discard(journalDir, journal);
			return;
		}
	}
	report.changed.push(journal.id);
	discard(journalDir, journal);
}

/** Recovers every journal whose owner is dead on this machine; foreign and live ones are skipped. */
export function recoverDeadJournals(
	journalDir: string,
	machineId: string,
	kinds?: readonly JournalKind[],
): RecoveryReport {
	const report: RecoveryReport = {
		finished: [],
		replayed: [],
		rolledBack: [],
		changed: [],
		skipped: [],
	};
	for (const journal of listJournals(journalDir)) {
		if (kinds !== undefined && !kinds.includes(journal.kind)) {
			continue;
		}
		if (journal.owner.machineId !== machineId || isLive(journal.owner)) {
			report.skipped.push(journal.id);
			continue;
		}
		recoverJournal(journalDir, journal, report);
	}
	return report;
}

/** Recovers one journal the operator vouched for, whatever machine owns it (the `recover` command). */
export function recoverForeignJournal(
	journalDir: string,
	id: string,
	confirmedMachineId: string,
): RecoveryReport {
	const report: RecoveryReport = {
		finished: [],
		replayed: [],
		rolledBack: [],
		changed: [],
		skipped: [],
	};
	const journal = readJournal(journalPath(journalDir, id));
	if (journal === null) {
		throw new Error(`no journal ${id} in ${journalDir}`);
	}
	if (journal.owner.machineId !== confirmedMachineId) {
		throw new Error(
			`journal ${id} belongs to machine ${journal.owner.machineId}, not ${confirmedMachineId}`,
		);
	}
	recoverJournal(journalDir, journal, report);
	return report;
}

export function removeJournalDir(journalDir: string): void {
	removeWithRetry(journalDir);
}
