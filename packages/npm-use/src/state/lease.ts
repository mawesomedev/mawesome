import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isLive, ownIdentity, type ProcessIdentity } from './proc.ts';

/** What a lease, gate or lock file records about its owner (spec LEASE-1, PROC-1). */
export interface OwnerRecord extends ProcessIdentity {
	host: string;
	machineId: string;
	createdAt: string;
}

export interface Lease {
	path: string;
	release(): void;
}

export function leasesDir(entry: string): string {
	return `${entry}.leases`;
}

export function gatePath(entry: string): string {
	return `${entry}.prune`;
}

export function newToken(): string {
	return randomBytes(8).toString('hex');
}

export function ownerRecord(
	machineId: string,
	identity: ProcessIdentity = ownIdentity(),
): OwnerRecord {
	return { ...identity, host: hostname(), machineId, createdAt: new Date().toISOString() };
}

export function readOwner(file: string): OwnerRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OwnerRecord>;
		if (typeof parsed.pid !== 'number') {
			return null;
		}
		return {
			pid: parsed.pid,
			start: typeof parsed.start === 'string' ? parsed.start : null,
			host: typeof parsed.host === 'string' ? parsed.host : '?',
			machineId: typeof parsed.machineId === 'string' ? parsed.machineId : '?',
			createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
		};
	} catch {
		return null;
	}
}

/** A file in the per-machine cache belongs to a dead owner only when PROC-1 says so; unreadable means live. */
export function ownerLive(file: string): boolean {
	const owner = readOwner(file);
	return owner === null ? true : isLive(owner);
}

/** Creates a shared lease on `entry`; the file name is unique, so a prune can never delete a live one by mistake. */
export function createLease(entry: string, owner: OwnerRecord): Lease {
	const dir = leasesDir(entry);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, newToken());
	writeFileSync(path, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
	return {
		path,
		release() {
			rmSync(path, { force: true });
		},
	};
}

export function listLeases(entry: string): string[] {
	try {
		return readdirSync(leasesDir(entry)).map((name) => join(leasesDir(entry), name));
	} catch {
		return [];
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const GATE_WAIT_MS = 5000;

/**
 * The runtime's shared lease (spec LEASE-1): lease first, then look for a live prune gate.
 * A live gate means the entry is going away: wait briefly, retry once, else return null so the caller fetches a private entry.
 */
export async function acquireShared(
	entry: string,
	owner: OwnerRecord,
	options: { waitMs?: number } = {},
): Promise<Lease | null> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const lease = createLease(entry, owner);
		const gate = gatePath(entry);
		let gated = false;
		try {
			gated = ownerLive(gate);
		} catch {
			gated = false;
		}
		if (!gated || !gateExists(gate)) {
			return lease;
		}
		lease.release();
		const deadline = Date.now() + (options.waitMs ?? GATE_WAIT_MS);
		while (Date.now() < deadline && gateExists(gate)) {
			await sleep(50);
		}
	}
	return null;
}

function gateExists(gate: string): boolean {
	try {
		return readOwner(gate) !== null;
	} catch {
		return false;
	}
}

/** Creates the prune gate with O_EXCL; false when another gate exists (there is only ever one prune, so a leftover). */
export function createGate(entry: string, owner: OwnerRecord): boolean {
	try {
		writeFileSync(gatePath(entry), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return false;
		}
		// A gate without a readable owner would make every later prune skip the entry.
		rmSync(gatePath(entry), { force: true });
		throw error;
	}
	return true;
}

export function removeGate(entry: string): void {
	rmSync(gatePath(entry), { force: true });
}
