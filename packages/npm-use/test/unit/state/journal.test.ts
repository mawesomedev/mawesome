import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../../../src/state/atomic.ts';
import {
	journalPath,
	listJournals,
	mutateFile,
	recoverDeadJournals,
	recoverForeignJournal,
	type Journal,
} from '../../../src/state/journal.ts';
import { captureMeta, sha256 } from '../../../src/state/meta.ts';
import type { OwnerRecord } from '../../../src/state/lease.ts';
import { deadOwner, liveOwner, MACHINE } from '../../helpers/owners.ts';
import { makeTree, removeTrees } from '../../helpers/tree.ts';

afterEach(removeTrees);

describe('mutateFile', () => {
	it('creates, replaces and deletes, leaving no journal behind', () => {
		const root = makeTree({ journal: {}, 'profile.sh': 'export A=1\n' });
		const target = join(root, 'profile.sh');
		mutateFile(
			join(root, 'journal'),
			'profile',
			liveOwner(),
			target,
			Buffer.from('export A=1\nexport B=2\n'),
		);
		expect(readFileSync(target, 'utf8')).toBe('export A=1\nexport B=2\n');
		mutateFile(
			join(root, 'journal'),
			'profile',
			liveOwner(),
			join(root, 'new.sh'),
			Buffer.from('fresh\n'),
		);
		expect(readFileSync(join(root, 'new.sh'), 'utf8')).toBe('fresh\n');
		mutateFile(join(root, 'journal'), 'profile', liveOwner(), target, null);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(root, 'journal'))).toEqual([]);
	});
});

/** Lays out the state a crash leaves after each step of a replace, then recovers it. */
function stagedJournal(
	root: string,
	owner: OwnerRecord,
	options: { original: string | null; intended: string | null },
): Journal {
	const journalDir = join(root, 'journal');
	const target = join(root, 'target.txt');
	if (options.original !== null) {
		writeFileSync(target, options.original);
	}
	const id = 'profile-0123456789abcdef';
	const backup = options.original === null ? null : join(journalDir, `${id}.bak`);
	if (backup !== null) {
		writeFileSync(backup, options.original ?? '');
	}
	const staged = options.intended === null ? null : join(journalDir, `${id}.new`);
	if (staged !== null) {
		writeFileSync(staged, options.intended ?? '');
	}
	const journal: Journal = {
		id,
		kind: 'profile',
		owner,
		target,
		original: captureMeta(target),
		intended: options.intended === null ? null : sha256(options.intended),
		staged,
		backup,
		mode: 0o644,
		createdAt: 'now',
	};
	atomicWrite(journalPath(journalDir, id), JSON.stringify(journal));
	return journal;
}

describe('recoverDeadJournals', () => {
	it('replays a change that never reached the target', async () => {
		const root = makeTree({ journal: {} });
		stagedJournal(root, await deadOwner(), { original: 'old', intended: 'new' });
		const report = recoverDeadJournals(join(root, 'journal'), MACHINE);
		expect(report.replayed).toHaveLength(1);
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('new');
		expect(listJournals(join(root, 'journal'))).toEqual([]);
		expect(readdirSync(join(root, 'journal'))).toEqual([]);
	});

	it('finishes a change that already landed', async () => {
		const root = makeTree({ journal: {} });
		stagedJournal(root, await deadOwner(), { original: 'old', intended: 'new' });
		writeFileSync(join(root, 'target.txt'), 'new');
		const report = recoverDeadJournals(join(root, 'journal'), MACHINE);
		expect(report.finished).toHaveLength(1);
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('new');
	});

	it('rolls back a torn write from the backup', async () => {
		const root = makeTree({ journal: {} });
		stagedJournal(root, await deadOwner(), { original: 'old', intended: 'new' });
		writeFileSync(join(root, 'target.txt'), 'ne');
		const report = recoverDeadJournals(join(root, 'journal'), MACHINE);
		expect(report.rolledBack).toHaveLength(1);
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('old');
	});

	it('leaves a target someone else changed and reports it', async () => {
		const root = makeTree({ journal: {} });
		const journal = stagedJournal(root, await deadOwner(), { original: 'old', intended: 'new' });
		writeFileSync(journal.backup as string, 'not the original');
		writeFileSync(join(root, 'target.txt'), 'theirs');
		const report = recoverDeadJournals(join(root, 'journal'), MACHINE);
		expect(report.changed).toHaveLength(1);
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('theirs');
		expect(listJournals(join(root, 'journal'))).toEqual([]);
	});

	it('handles creations and deletions', async () => {
		const created = makeTree({ journal: {} });
		stagedJournal(created, await deadOwner(), { original: null, intended: 'fresh' });
		expect(recoverDeadJournals(join(created, 'journal'), MACHINE).replayed).toHaveLength(1);
		expect(readFileSync(join(created, 'target.txt'), 'utf8')).toBe('fresh');

		const deleted = makeTree({ journal: {} });
		stagedJournal(deleted, await deadOwner(), { original: 'old', intended: null });
		expect(recoverDeadJournals(join(deleted, 'journal'), MACHINE).replayed).toHaveLength(1);
		expect(existsSync(join(deleted, 'target.txt'))).toBe(false);

		const done = makeTree({ journal: {} });
		stagedJournal(done, await deadOwner(), { original: 'old', intended: null });
		writeFileSync(join(done, 'target.txt'), 'old');
		// The deletion did not happen yet and the target is still the original: replay it.
		expect(recoverDeadJournals(join(done, 'journal'), MACHINE).replayed).toHaveLength(1);
	});

	it('skips live owners and other machines, which the recover command handles', async () => {
		const root = makeTree({ journal: {} });
		stagedJournal(root, liveOwner(), { original: 'old', intended: 'new' });
		expect(recoverDeadJournals(join(root, 'journal'), MACHINE).skipped).toHaveLength(1);
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('old');

		const foreign = makeTree({ journal: {} });
		const journal = stagedJournal(foreign, await deadOwner('build-box'), {
			original: 'old',
			intended: 'new',
		});
		expect(recoverDeadJournals(join(foreign, 'journal'), MACHINE).skipped).toHaveLength(1);
		expect(() =>
			recoverForeignJournal(join(foreign, 'journal'), journal.id, 'wrong-machine'),
		).toThrow(/belongs to machine build-box/);
		expect(
			recoverForeignJournal(join(foreign, 'journal'), journal.id, 'build-box').replayed,
		).toHaveLength(1);
		expect(readFileSync(join(foreign, 'target.txt'), 'utf8')).toBe('new');
	});

	it('recovers only the requested kinds', async () => {
		const root = makeTree({ journal: {} });
		stagedJournal(root, await deadOwner(), { original: 'old', intended: 'new' });
		expect(recoverDeadJournals(join(root, 'journal'), MACHINE, ['launcher']).replayed).toHaveLength(
			0,
		);
		expect(listJournals(join(root, 'journal'))).toHaveLength(1);
	});
});
