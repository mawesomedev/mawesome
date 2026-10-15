import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRegistry } from '@mawesome/testing/registry';
import { buildTarball, npmPackageEntries } from '@mawesome/testing/registry/tar';
import { NpmUseError } from '../../src/errors.ts';
import { REGISTRY_KEYS } from '../../src/install/keys.ts';
import {
	checkIntegrity,
	entryRelativePath,
	fileDigests,
	readVerified,
	safeExtract,
	verifySignatures,
	writeVerified,
} from '../../src/install/verify.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

const never = async () => null;

describe('verifySignatures', () => {
	const registry = new FakeRegistry();
	const keys = [{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: null }];

	it('verifies the real registry signature of npm 12.2.0 with the pinned keyring', async () => {
		const keyid = await verifySignatures({
			name: 'npm',
			version: '12.2.0',
			integrity:
				'sha512-ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ==',
			signatures: [
				{
					sig: 'MEYCIQCXvXZm01EiQIfCOjMbCna9ATH8xNjCbTX7B6rGjB8USgIhAPKM2KBQSm3OwLzM4Ayj4PxP5emDpys9665mIf2vokPO',
					keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
				},
			],
			publishedAt: never,
			keys: REGISTRY_KEYS,
			registry: 'https://registry.npmjs.org/',
			pinned: false,
		});
		expect(keyid).toBe('SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U');
	});

	it('accepts a valid signature and rejects a forged one', async () => {
		const stored = registry.publish('12.0.0');
		const base = {
			name: 'npm',
			version: '12.0.0',
			integrity: stored.integrity,
			publishedAt: never,
			keys,
			registry: 'r',
			pinned: false,
		};
		await expect(verifySignatures({ ...base, signatures: stored.signatures })).resolves.toBe(
			registry.keyid,
		);
		const forged = [{ keyid: registry.keyid, sig: Buffer.from('nope').toString('base64') }];
		await expect(verifySignatures({ ...base, signatures: forged })).rejects.toMatchObject({
			id: 'M-UNSIGNED',
		});
		const other = { ...base, integrity: 'sha512-AAAA' };
		await expect(
			verifySignatures({ ...other, signatures: stored.signatures }),
		).rejects.toMatchObject({ id: 'M-UNSIGNED' });
	});

	it('fails with M-KEY for an unknown key id and M-UNSIGNED without signatures unless pinned', async () => {
		const stored = registry.publish('12.0.1');
		const base = {
			name: 'npm',
			version: '12.0.1',
			integrity: stored.integrity,
			publishedAt: never,
			keys,
			registry: 'r',
		};
		const unknown = [{ keyid: 'SHA256:unknown', sig: stored.signatures[0]?.sig ?? '' }];
		await expect(
			verifySignatures({ ...base, signatures: unknown, pinned: false }),
		).rejects.toMatchObject({ id: 'M-KEY' });
		await expect(
			verifySignatures({ ...base, signatures: [], pinned: false }),
		).rejects.toMatchObject({ id: 'M-UNSIGNED' });
		await expect(verifySignatures({ ...base, signatures: [], pinned: true })).resolves.toBeNull();
	});

	it('honours expiry against the publication time and never trusts a revoked key', async () => {
		const stored = registry.publish('12.0.2');
		const expired = [
			{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: '2026-06-01T00:00:00.000Z' },
		];
		const base = {
			name: 'npm',
			version: '12.0.2',
			integrity: stored.integrity,
			signatures: stored.signatures,
			registry: 'r',
			pinned: false,
		};
		await expect(
			verifySignatures({
				...base,
				keys: expired,
				publishedAt: async () => '2026-01-01T00:00:00.000Z',
			}),
		).resolves.toBe(registry.keyid);
		await expect(
			verifySignatures({
				...base,
				keys: expired,
				publishedAt: async () => '2026-07-01T00:00:00.000Z',
			}),
		).rejects.toMatchObject({ id: 'M-UNSIGNED' });
		await expect(
			verifySignatures({ ...base, keys: expired, publishedAt: async () => null }),
		).rejects.toMatchObject({ id: 'M-UNSIGNED' });
		const revoked = [
			{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: null, revoked: true },
		];
		await expect(
			verifySignatures({
				...base,
				keys: revoked,
				publishedAt: async () => '2026-01-01T00:00:00.000Z',
			}),
		).rejects.toMatchObject({ id: 'M-UNSIGNED' });
	});

	it('needs only one valid signature among several', async () => {
		const stored = registry.publish('12.0.3');
		const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const payload = Buffer.from(`npm@12.0.3:${stored.integrity}`);
		const signatures = [
			{
				keyid: registry.keyid,
				sig: sign('sha256', payload, stranger.privateKey).toString('base64'),
			},
			...stored.signatures,
		];
		await expect(
			verifySignatures({
				name: 'npm',
				version: '12.0.3',
				integrity: stored.integrity,
				signatures,
				publishedAt: never,
				keys,
				registry: 'r',
				pinned: false,
			}),
		).resolves.toBe(registry.keyid);
	});
});

describe('integrity', () => {
	it('digests a file and compares against the registry integrity and a pinned hash', async () => {
		const root = makeTree({ 'a.tgz': 'hello' });
		const digests = await fileDigests(join(root, 'a.tgz'));
		expect(digests.sha256hex).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
		expect(() => checkIntegrity(digests, digests.sha512, null)).not.toThrow();
		expect(() =>
			checkIntegrity(digests, digests.sha512, { algorithm: 'sha256', hex: digests.sha256hex }),
		).not.toThrow();
		expect(() => checkIntegrity(digests, 'sha512-AAAA', null)).toThrow(NpmUseError);
		expect(() =>
			checkIntegrity(digests, digests.sha512, { algorithm: 'sha224', hex: 'f'.repeat(56) }),
		).toThrow(/pinned hash/);
	});
});

describe('entryRelativePath', () => {
	it('keeps paths under package/ and rejects everything else', () => {
		expect(entryRelativePath('package/bin/npm-cli.js')).toBe('bin/npm-cli.js');
		expect(entryRelativePath('package/')).toBe('');
		expect(entryRelativePath('./package/./x')).toBe('x');
		for (const bad of [
			'/etc/passwd',
			'C:/x',
			'package/../x',
			'../package/x',
			'other/x',
			'package/a\\b',
			'package/a\0b',
			'package/\x01',
		]) {
			expect(() => entryRelativePath(bad), bad).toThrow(NpmUseError);
		}
	});
});

describe('safeExtract', () => {
	it('extracts files and directories with normalized modes', async () => {
		const root = makeTree({});
		const tarball = join(root, 'npm.tgz');
		writeFileSync(
			tarball,
			buildTarball(
				npmPackageEntries('12.0.0', {
					extra: [{ path: 'package/lib/x.js', content: 'x', mode: 0o4777 }],
				}),
			),
		);
		const dest = join(root, 'out');
		await safeExtract(tarball, dest);
		expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))).toMatchObject({
			name: 'npm',
			version: '12.0.0',
		});
		if (process.platform !== 'win32') {
			expect(statSync(join(dest, 'bin', 'npm-cli.js')).mode & 0o7777).toBe(0o755);
			expect(statSync(join(dest, 'package.json')).mode & 0o7777).toBe(0o644);
			expect(statSync(join(dest, 'lib', 'x.js')).mode & 0o7777).toBe(0o755);
		}
	});

	it('creates missing parent directories', async () => {
		const root = makeTree({});
		const tarball = join(root, 'npm.tgz');
		writeFileSync(tarball, buildTarball([{ path: 'package/deep/er/file.txt', content: 'f' }]));
		await safeExtract(tarball, join(root, 'out'));
		expect(readFileSync(join(root, 'out', 'deep', 'er', 'file.txt'), 'utf8')).toBe('f');
	});

	it('aborts on unsafe entries without writing past them', async () => {
		const cases: Array<[string, Parameters<typeof buildTarball>[0]]> = [
			[
				'symlink',
				[
					{ path: 'package/a', content: 'a' },
					{ path: 'package/link', type: '2', linkpath: '/etc/passwd' },
					{ path: 'package/z', content: 'z' },
				],
			],
			['hardlink', [{ path: 'package/link', type: '1', linkpath: 'package/a' }]],
			['device', [{ path: 'package/dev', type: '3' }]],
			['traversal', [{ path: 'package/../escape', content: 'e' }]],
			['absolute', [{ path: '/tmp/escape', content: 'e' }]],
			['outside', [{ path: 'other/file', content: 'e' }]],
		];
		for (const [name, entries] of cases) {
			const root = makeTree({});
			const tarball = join(root, 'npm.tgz');
			writeFileSync(tarball, buildTarball(entries));
			await expect(safeExtract(tarball, join(root, 'out')), name).rejects.toMatchObject({
				id: 'M-INTEGRITY',
			});
			expect(existsSync(join(root, 'out', 'z')), name).toBe(false);
			expect(existsSync(join(root, 'escape')), name).toBe(false);
			expect(() => lstatSync(join(root, 'out', 'link'))).toThrow();
		}
	});

	it('enforces the entry and size limits', async () => {
		const root = makeTree({});
		const tarball = join(root, 'npm.tgz');
		writeFileSync(
			tarball,
			buildTarball([
				{ path: 'package/a', content: 'a' },
				{ path: 'package/b', content: 'b' },
				{ path: 'package/c', content: 'c' },
			]),
		);
		await expect(
			safeExtract(tarball, join(root, 'out1'), { maxEntries: 2, maxBytes: 1e9 }),
		).rejects.toThrow(/entries/);
		await expect(
			safeExtract(tarball, join(root, 'out2'), { maxEntries: 100, maxBytes: 2 }),
		).rejects.toThrow(/bytes/);
	});

	it('rejects a file that is not a tarball', async () => {
		const root = makeTree({ 'npm.tgz': 'not gzip' });
		await expect(safeExtract(join(root, 'npm.tgz'), join(root, 'out'))).rejects.toMatchObject({
			id: 'M-INTEGRITY',
		});
	});
});

describe('.verified', () => {
	it('round-trips and rejects garbage', () => {
		const root = makeTree({});
		writeVerified(root, {
			version: '1.0.0',
			integrity: 'sha512-x',
			keyid: null,
			verifiedAt: 'now',
		});
		expect(readVerified(root)).toEqual({
			version: '1.0.0',
			integrity: 'sha512-x',
			keyid: null,
			verifiedAt: 'now',
		});
		writeFileSync(join(root, '.verified'), '{"version":1}');
		expect(readVerified(root)).toBeNull();
		expect(readVerified(join(root, 'missing'))).toBeNull();
	});
});
