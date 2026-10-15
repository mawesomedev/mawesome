import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, NpmUseError } from '../errors.ts';
import { lockedMessage } from '../messages.ts';
import { newToken, type OwnerRecord } from './lease.ts';
import { isLive } from './proc.ts';

export const LOCK_FILE = 'lock';
const WAIT_LIMIT_MS = 10_000;

/** What the lock file records: the owner plus a token only the owner knows, so only it can release. */
export interface LockRecord extends OwnerRecord {
	token: string;
}

export interface Lock {
	path: string;
	release(): void;
}

export function lockPath(stateDir: string): string {
	return join(stateDir, LOCK_FILE);
}

export function readLock(stateDir: string): LockRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(lockPath(stateDir), 'utf8')) as Partial<LockRecord>;
		if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') {
			return null;
		}
		return {
			pid: parsed.pid,
			start: typeof parsed.start === 'string' ? parsed.start : null,
			host: typeof parsed.host === 'string' ? parsed.host : '?',
			machineId: typeof parsed.machineId === 'string' ? parsed.machineId : '?',
			createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
			token: parsed.token,
		};
	} catch {
		return null;
	}
}

/** Whether the lock owner can be shown to be dead: only on this machine, and only by PROC-1. */
export function lockOwnerLive(record: LockRecord | null, machineId: string): boolean {
	if (record === null) {
		return true;
	}
	if (record.machineId !== machineId) {
		return true;
	}
	return isLive(record);
}

function tryCreate(path: string, record: LockRecord): boolean {
	try {
		writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return false;
		}
		// A half-written lock would block everyone with no owner to release it.
		rmSync(path, { force: true });
		throw error;
	}
	return true;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the exclusive lock (spec MUT-1): created with O_EXCL, released only by its owner, never reclaimed.
 * Waits with backoff for up to 10 s, then fails with M-LOCKED naming the file and whether the owner is live.
 */
export async function acquireLock(
	stateDir: string,
	owner: OwnerRecord,
	options: { waitMs?: number } = {},
): Promise<Lock> {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = lockPath(stateDir);
	const record: LockRecord = { ...owner, token: newToken() };
	const deadline = Date.now() + (options.waitMs ?? WAIT_LIMIT_MS);
	let delay = 50;
	for (;;) {
		if (tryCreate(path, record)) {
			return {
				path,
				release() {
					// Only the owner removes the lock, and only while the file still carries its token.
					if (readLock(stateDir)?.token === record.token) {
						rmSync(path, { force: true });
					}
				},
			};
		}
		if (Date.now() + delay > deadline) {
			const holder = readLock(stateDir);
			const foreign = holder !== null && holder.machineId !== owner.machineId;
			const live = lockOwnerLive(holder, owner.machineId);
			throw new NpmUseError('M-LOCKED', EXIT.problems, lockedMessage(path, holder, live, foreign));
		}
		await sleep(delay);
		delay = Math.min(delay * 2, 1000);
	}
}

/** One attempt, no waiting; for the launcher's recovery check, which must never delay npm. */
export function tryLock(stateDir: string, owner: OwnerRecord): Lock | null {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = lockPath(stateDir);
	const record: LockRecord = { ...owner, token: newToken() };
	if (!tryCreate(path, record)) {
		return null;
	}
	return {
		path,
		release() {
			if (readLock(stateDir)?.token === record.token) {
				rmSync(path, { force: true });
			}
		},
	};
}
