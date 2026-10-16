import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	acquireLock,
	lockOwnerLive,
	lockPath,
	readLock,
	tryLock,
} from '../../../src/state/lock.ts';
import {
	deadOwner,
	liveOwner,
	MACHINE,
	reusedPidOwner,
	stop,
	suspendedOwner,
} from '../../helpers/owners.ts';
import { makeTree, removeTrees } from '../../helpers/tree.ts';

afterEach(removeTrees);

const worker = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'fixtures',
	'lock-worker.ts',
);

describe('acquireLock', () => {
	it('creates, records the owner, and releases only its own lock', async () => {
		const state = makeTree({});
		const lock = await acquireLock(state, liveOwner());
		expect(readLock(state)).toMatchObject({ pid: process.pid, machineId: MACHINE });
		writeFileSync(lockPath(state), JSON.stringify({ ...readLock(state), token: 'someone-else' }));
		lock.release();
		expect(existsSync(lockPath(state))).toBe(true);
		rmSync(lockPath(state));
		const again = await acquireLock(state, liveOwner());
		again.release();
		expect(existsSync(lockPath(state))).toBe(false);
	});

	it('waits for a live holder and then proceeds', async () => {
		const state = makeTree({});
		const first = await acquireLock(state, liveOwner());
		setTimeout(() => first.release(), 200);
		const second = await acquireLock(state, liveOwner(), { waitMs: 3000 });
		expect(readLock(state)?.token).toBeDefined();
		second.release();
	});

	it('fails with M-LOCKED and says the holder is live while it runs', async () => {
		const state = makeTree({});
		const held = await acquireLock(state, liveOwner());
		await expect(acquireLock(state, liveOwner(), { waitMs: 150 })).rejects.toMatchObject({
			id: 'M-LOCKED',
			message: expect.stringContaining('still running'),
		});
		held.release();
	});

	it("never reclaims a crashed owner's lock but tells the user which file to delete", async () => {
		const state = makeTree({});
		const dead = await deadOwner();
		writeFileSync(lockPath(state), JSON.stringify({ ...dead, token: 'crashed' }));
		await expect(acquireLock(state, liveOwner(), { waitMs: 150 })).rejects.toMatchObject({
			id: 'M-LOCKED',
			message: expect.stringMatching(/no longer running\. Delete .*lock and retry/),
		});
		expect(existsSync(lockPath(state))).toBe(true);
		rmSync(lockPath(state));
		const lock = await acquireLock(state, liveOwner(), { waitMs: 150 });
		lock.release();
	});

	it('treats a lock from another machine as live and unverifiable', async () => {
		const state = makeTree({});
		const dead = await deadOwner('other-machine');
		writeFileSync(lockPath(state), JSON.stringify({ ...dead, token: 'remote', host: 'build-42' }));
		expect(lockOwnerLive(readLock(state), MACHINE)).toBe(true);
		await expect(acquireLock(state, liveOwner(), { waitMs: 150 })).rejects.toMatchObject({
			message: expect.stringContaining('cannot be verified from this machine'),
		});
	});

	it('counts a reused PID as dead and a suspended owner as live', async () => {
		const reused = await reusedPidOwner();
		const suspended = await suspendedOwner();
		try {
			expect(lockOwnerLive({ ...reused.owner, token: 't' }, MACHINE)).toBe(false);
			expect(lockOwnerLive({ ...suspended.owner, token: 't' }, MACHINE)).toBe(true);
		} finally {
			await stop(reused.child);
			await stop(suspended.child);
		}
	});

	it('tryLock never waits', async () => {
		const state = makeTree({});
		const lock = tryLock(state, liveOwner());
		expect(lock).not.toBeNull();
		expect(tryLock(state, liveOwner())).toBeNull();
		lock?.release();
		expect(tryLock(state, liveOwner())).not.toBeNull();
	});

	it('serializes writers across processes', { timeout: 30_000 }, async () => {
		const root = makeTree({ state: {} });
		const log = join(root, 'log.txt');
		writeFileSync(log, '');
		const children = ['a', 'b', 'c'].map((label) =>
			spawn(process.execPath, [worker, join(root, 'state'), log, label], {
				stdio: ['ignore', 'ignore', 'inherit'],
			}),
		);
		await Promise.all(
			children.map((child) => new Promise<void>((resolve) => child.on('exit', () => resolve()))),
		);
		expect(children.map((child) => child.exitCode)).toEqual([0, 0, 0]);
		const lines = readFileSync(log, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(6);
		for (let index = 0; index < lines.length; index += 2) {
			const label = lines[index]?.split(' ')[1];
			expect(lines[index]).toBe(`enter ${label}`);
			expect(lines[index + 1]).toBe(`leave ${label}`);
		}
		expect(existsSync(lockPath(join(root, 'state')))).toBe(false);
	});
});
