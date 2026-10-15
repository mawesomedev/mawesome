import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	canonicalEntry,
	entryName,
	isEntryName,
	listEntries,
	publishEntry,
	validateEntry,
} from '../../src/install/cache.ts';
import { writeVerified } from '../../src/install/verify.ts';
import { createGate, ownerRecord, removeGate } from '../../src/state/lease.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

const integrity = `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`;
const owner = ownerRecord('machine');

function entryDir(root: string, version: string, engines?: string): string {
	const dir = join(root, 'npm', entryName(version, integrity));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'npm', version, ...(engines ? { engines: { node: engines } } : {}) }),
	);
	writeVerified(dir, {
		version,
		integrity,
		keyid: null,
		sha256: 'x',
		sha224: 'y',
		verifiedAt: 'now',
	});
	return dir;
}

describe('entry names', () => {
	it('derive from the version and the integrity prefix', () => {
		expect(entryName('12.2.0', integrity)).toBe('12.2.0-abababababababab');
		expect(isEntryName('12.2.0-abababababababab')).toBe(true);
		expect(isEntryName('12.2.0-abababababababab.0123456789abcdef')).toBe(true);
		expect(isEntryName('12.2.0-abababababababab.leases')).toBe(false);
		expect(isEntryName('12.2.0-abababababababab.deleting.0123456789abcdef')).toBe(false);
		expect(() => entryName('1.0.0', 'sha256-x')).toThrow();
	});
});

describe('listEntries and validateEntry', () => {
	it('lists verified entries with their engines and validates the manifest against the marker', () => {
		const root = makeTree({});
		const dir = entryDir(root, '12.1.0', '>=22');
		entryDir(root, '12.0.0');
		mkdirSync(join(root, 'npm', '12.3.0-abababababababab'));
		expect(
			listEntries(root).map((entry) => [entry.version, entry.enginesNode, entry.entryPath]),
		).toEqual([
			['12.0.0', null, join(root, 'npm', entryName('12.0.0', integrity))],
			['12.1.0', '>=22', dir],
		]);
		expect(listEntries(join(root, 'nowhere'))).toEqual([]);
		expect(validateEntry(dir, integrity)).toBe(true);
		expect(validateEntry(dir, 'sha512-other')).toBe(false);
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'npm', version: '9.9.9' }));
		expect(validateEntry(dir, integrity)).toBe(false);
		expect(validateEntry(join(root, 'npm', '12.3.0-abababababababab'), integrity)).toBe(false);
	});
});

describe('publishEntry', () => {
	it('renames into place with a lease created first', () => {
		const root = makeTree({
			temp: { 'package.json': JSON.stringify({ name: 'npm', version: '12.0.0' }) },
		});
		writeVerified(join(root, 'temp'), {
			version: '12.0.0',
			integrity,
			keyid: null,
			sha256: 'x',
			sha224: 'y',
			verifiedAt: 'now',
		});
		const canonical = canonicalEntry(root, '12.0.0', integrity);
		mkdirSync(join(root, 'npm'));
		const published = publishEntry(join(root, 'temp'), canonical, integrity, owner);
		expect(published.entryPath).toBe(canonical);
		expect(existsSync(published.lease.path)).toBe(true);
		expect(published.lease.path.startsWith(`${canonical}.leases`)).toBe(true);
		expect(existsSync(join(root, 'temp'))).toBe(false);
		published.lease.release();
		expect(existsSync(published.lease.path)).toBe(false);
	});

	it('reuses a valid canonical entry and drops its own copy', () => {
		const root = makeTree({
			temp: { 'package.json': JSON.stringify({ name: 'npm', version: '12.0.0' }) },
		});
		const canonical = entryDir(root, '12.0.0');
		const published = publishEntry(join(root, 'temp'), canonical, integrity, owner);
		expect(published.entryPath).toBe(canonical);
		expect(existsSync(join(root, 'temp'))).toBe(false);
		expect(readdirSync(`${canonical}.leases`)).toHaveLength(1);
	});

	it('publishes privately while a live prune gate guards the canonical path', () => {
		const root = makeTree({
			temp: { 'package.json': JSON.stringify({ name: 'npm', version: '12.0.0' }) },
		});
		const canonical = canonicalEntry(root, '12.0.0', integrity);
		mkdirSync(join(root, 'npm'), { recursive: true });
		createGate(canonical, owner);
		const published = publishEntry(join(root, 'temp'), canonical, integrity, owner);
		expect(published.entryPath).not.toBe(canonical);
		expect(published.entryPath.startsWith(`${canonical}.`)).toBe(true);
		expect(existsSync(canonical)).toBe(false);
		expect(readdirSync(`${canonical}.leases`)).toEqual([]);
		removeGate(canonical);
	});

	it('sidesteps an invalid canonical entry with a private one and leaves the invalid one alone', () => {
		const root = makeTree({
			temp: { 'package.json': JSON.stringify({ name: 'npm', version: '12.0.0' }) },
		});
		const canonical = canonicalEntry(root, '12.0.0', integrity);
		mkdirSync(canonical, { recursive: true });
		writeFileSync(join(canonical, 'junk'), 'x');
		const published = publishEntry(join(root, 'temp'), canonical, integrity, owner);
		expect(published.entryPath).toMatch(
			new RegExp(`^${canonical.replace(/[\\/.]/g, '\\$&')}\\.[0-9a-f]{16}$`),
		);
		expect(existsSync(join(canonical, 'junk'))).toBe(true);
		expect(existsSync(join(published.entryPath, 'package.json'))).toBe(true);
		expect(existsSync(published.lease.path)).toBe(true);
	});
});
