import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalEntry, entryName } from '../../../src/install/cache.ts';
import { writeVerified } from '../../../src/install/verify.ts';
import {
	acquireShared,
	createGate,
	createLease,
	gatePath,
	leasesDir,
	listLeases,
	removeGate,
} from '../../../src/state/lease.ts';
import {
	lastUsed,
	pruneCache,
	pruneEntry,
	pruneReason,
	touchUsed,
} from '../../../src/state/prune.ts';
import {
	deadOwner,
	liveOwner,
	reusedPidOwner,
	stop,
	suspendedOwner,
} from '../../helpers/owners.ts';
import { makeTree, removeTrees } from '../../helpers/tree.ts';

afterEach(removeTrees);

const integrity = `sha512-${Buffer.from('cd'.repeat(64), 'hex').toString('base64')}`;

function entry(root: string, version: string, token?: string): string {
	const base = canonicalEntry(root, version, integrity);
	const dir = token === undefined ? base : `${base}.${token}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'npm', version }));
	writeVerified(dir, { version, integrity, keyid: null, verifiedAt: 'now' });
	return dir;
}

describe('acquireShared', () => {
	it('leases at once without a gate and when the gate owner is dead', async () => {
		const root = makeTree({});
		const dir = entry(root, '13.0.0');
		const lease = await acquireShared(dir, liveOwner());
		expect(lease).not.toBeNull();
		expect(listLeases(dir)).toHaveLength(1);
		lease?.release();
		createGate(dir, await deadOwner());
		const second = await acquireShared(dir, liveOwner(), { waitMs: 100 });
		expect(second).not.toBeNull();
		second?.release();
	});

	it('gives up on a live gate after waiting and retrying once', async () => {
		const root = makeTree({});
		const dir = entry(root, '13.0.0');
		createGate(dir, liveOwner());
		const started = Date.now();
		expect(await acquireShared(dir, liveOwner(), { waitMs: 120 })).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
		expect(listLeases(dir)).toEqual([]);
		removeGate(dir);
		expect(await acquireShared(dir, liveOwner(), { waitMs: 100 })).not.toBeNull();
	});
});

describe('pruneEntry', () => {
	it('removes an entry nobody uses, including its leases and used marker', async () => {
		const root = makeTree({});
		const dir = entry(root, '13.0.0');
		createLease(dir, await deadOwner());
		touchUsed(dir);
		expect(pruneEntry(dir, liveOwner())).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(leasesDir(dir))).toBe(false);
		expect(existsSync(gatePath(dir))).toBe(false);
		expect(lastUsed(dir)).toBeNull();
		expect(readdirSync(join(root, 'npm'))).toEqual([]);
	});

	it('keeps an entry with a live lease, a suspended owner, and treats a reused PID as dead', async () => {
		const root = makeTree({});
		const live = entry(root, '13.0.0');
		const mine = createLease(live, liveOwner());
		expect(pruneEntry(live, liveOwner())).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(gatePath(live))).toBe(false);
		mine.release();

		const suspended = await suspendedOwner();
		const reused = await reusedPidOwner();
		try {
			const paused = entry(root, '13.1.0');
			createLease(paused, suspended.owner);
			expect(pruneEntry(paused, liveOwner())).toBe(false);
			const stale = entry(root, '13.2.0');
			createLease(stale, reused.owner);
			expect(pruneEntry(stale, liveOwner())).toBe(true);
		} finally {
			await stop(suspended.child);
			await stop(reused.child);
		}
	});

	it('converges after a crash at every step', async () => {
		const root = makeTree({});
		const dead = await deadOwner();
		// Crash after creating the gate.
		const first = entry(root, '13.0.0');
		createGate(first, dead);
		expect(pruneEntry(first, liveOwner())).toBe(true);
		expect(existsSync(first)).toBe(false);
		// Crash after renaming the entry, gate still there.
		const second = entry(root, '13.1.0');
		mkdirSync(`${second}.deleting.0123456789abcdef`);
		writeFileSync(join(`${second}.deleting.0123456789abcdef`, 'x'), '');
		createGate(second, dead);
		const report = pruneCache(root, liveOwner(), { maxAgeMs: 0 });
		expect(report.removed).toContain(`${entryName('13.1.0', integrity)}.deleting.0123456789abcdef`);
		expect(readdirSync(join(root, 'npm')).filter((name) => name.includes('13.1.0'))).toEqual([]);
	});
});

describe('pruneCache', () => {
	it('removes stale, invalid and orphaned private entries and keeps the rest', async () => {
		const root = makeTree({});
		const fresh = entry(root, '13.0.0');
		touchUsed(fresh);
		const stale = entry(root, '13.1.0');
		touchUsed(stale);
		const old = new Date(Date.now() - 100 * 86_400_000);
		utimesSync(`${stale}.used`, old, old);
		const invalid = entry(root, '13.2.0');
		writeFileSync(join(invalid, 'package.json'), '{"name":"npm","version":"0.0.0"}');
		const orphan = entry(root, '13.3.0', '0123456789abcdef');
		createLease(orphan, await deadOwner());
		const held = entry(root, '13.4.0', 'fedcba9876543210');
		const lease = createLease(held, liveOwner());
		expect(
			pruneReason(root, entryName('13.0.0', integrity), { maxAgeMs: 90 * 86_400_000 }),
		).toBeNull();
		expect(pruneReason(root, entryName('13.1.0', integrity), { maxAgeMs: 90 * 86_400_000 })).toBe(
			'stale',
		);
		expect(pruneReason(root, entryName('13.2.0', integrity), { maxAgeMs: 90 * 86_400_000 })).toBe(
			'invalid',
		);
		expect(
			pruneReason(root, `${entryName('13.3.0', integrity)}.0123456789abcdef`, {
				maxAgeMs: 90 * 86_400_000,
			}),
		).toBe('orphan-private');
		const report = pruneCache(root, liveOwner(), { maxAgeMs: 90 * 86_400_000 });
		expect(report.removed.toSorted()).toEqual(
			[
				entryName('13.1.0', integrity),
				entryName('13.2.0', integrity),
				`${entryName('13.3.0', integrity)}.0123456789abcdef`,
			].toSorted(),
		);
		expect(report.kept).toEqual([
			entryName('13.0.0', integrity),
			`${entryName('13.4.0', integrity)}.fedcba9876543210`,
		]);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(held)).toBe(true);
		lease.release();
	});
});
