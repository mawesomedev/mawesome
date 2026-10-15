import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownIdentity, type ProcessIdentity } from './proc.ts';

/** What a lease or lock file records about its owner (spec LEASE-1, PROC-1). */
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

export function newToken(): string {
	return randomBytes(8).toString('hex');
}

export function ownerRecord(
	machineId: string,
	identity: ProcessIdentity = ownIdentity(),
): OwnerRecord {
	return { ...identity, host: hostname(), machineId, createdAt: new Date().toISOString() };
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
