import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRegistry } from '@mawesome/testing/registry';
import { serveRegistry } from '@mawesome/testing/registry/server';
import { buildTarball, npmPackageEntries } from '@mawesome/testing/registry/tar';
import { createHarness, type Harness } from '../helpers/registry-harness.ts';
import { removeTrees } from '../helpers/tree.ts';

const open: Harness[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const harness of open.splice(0)) {
		await harness.close();
	}
	for (const close of closers.splice(0)) {
		await close();
	}
	removeTrees();
});

async function start(...args: Parameters<typeof createHarness>): Promise<Harness> {
	const created = await createHarness(...args);
	open.push(created);
	return created;
}

const npm = { name: 'npm' };

/** Entry directories under the cache, ignoring lease dirs; an absent cache holds none. */
function publishedEntries(cache: string): string[] {
	const dir = join(cache, 'npm');
	return existsSync(dir)
		? readdirSync(dir).filter((name) => /^\d/.test(name) && !name.includes('.leases'))
		: [];
}

describe('download, verify and cache', { timeout: 120_000 }, () => {
	it('downloads the highest version whose engines accept this Node, then serves it from the cache', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '^13' } } });
		h.registry.publish('13.0.0', { engines: '>=22' });
		h.registry.publish('13.1.0', { engines: '>=22' });
		h.registry.publish('13.9.0', { engines: '>=99' });
		const first = await h.run(['-v']);
		expect(first.result).toMatchObject({ kind: 'download', version: '13.1.0' });
		expect(first.stdout).toBe('13.1.0 -v');
		expect(existsSync(join(first.entryPath, '.verified'))).toBe(true);
		const requests = h.registry.requests.length;
		expect(requests).toBeGreaterThan(0);
		const second = await h.run(['ci']);
		expect(second.result).toMatchObject({
			kind: 'cached',
			version: '13.1.0',
			cliPath: first.result.cliPath,
		});
		expect(second.stdout).toBe('13.1.0 ci');
		expect(h.registry.requests.length).toBe(requests);
	});

	it('serves a cached match offline and fails cleanly when nothing is cached', async () => {
		const h = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
			env: { NPM_USE_OFFLINE: '1' },
		});
		h.registry.publish('13.0.0');
		await expect(h.resolve()).rejects.toMatchObject({ id: 'M-NOMATCH', exitCode: 3 });
		expect(h.registry.requests).toHaveLength(0);
	});

	it('rejects a tarball whose bytes differ from the registry integrity', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		const tampered = buildTarball(
			npmPackageEntries('13.0.0', { extra: [{ path: 'package/evil.js', content: 'x' }] }),
		);
		h.registry.publish('13.0.0', { tamperedTarball: tampered });
		await expect(h.run()).rejects.toMatchObject({ id: 'M-INTEGRITY', exitCode: 5 });
		expect(publishedEntries(h.context.dirs.cache)).toHaveLength(0);
	});

	it('refuses an unsigned registry unless the spec pins a hash', async () => {
		const unsigned = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
		});
		unsigned.registry.publish('13.0.0', { signers: 'none' });
		await expect(unsigned.run()).rejects.toMatchObject({ id: 'M-UNSIGNED', exitCode: 5 });

		const pinned = await start({});
		const stored = pinned.registry.publish('13.0.0', { signers: 'none' });
		const hex = Buffer.from(stored.integrity.slice('sha512-'.length), 'base64').toString('hex');
		writeFileSync(
			join(pinned.project, 'package.json'),
			JSON.stringify({ packageManager: `npm@13.0.0+sha512.${hex}` }),
		);
		const result = await pinned.run();
		expect(result.stdout).toBe('13.0.0 -v');
		expect(existsSync(join(result.entryPath, '.verified'))).toBe(true);

		const wrongPin = await start({ packageManager: `npm@13.0.0+sha512.${'0'.repeat(128)}` });
		wrongPin.registry.publish('13.0.0');
		await expect(wrongPin.resolve()).rejects.toMatchObject({ id: 'M-NOMATCH' });
	});

	it('keeps an entry verified only by a pin away from projects without that pin', async () => {
		const h = await start({});
		const stored = h.registry.publish('13.0.0', { signers: 'none' });
		const hex = Buffer.from(stored.integrity.slice('sha512-'.length), 'base64').toString('hex');
		writeFileSync(
			join(h.project, 'package.json'),
			JSON.stringify({ packageManager: `npm@13.0.0+sha512.${hex}` }),
		);
		expect((await h.run()).stdout).toBe('13.0.0 -v');
		writeFileSync(
			join(h.project, 'package.json'),
			JSON.stringify({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } }),
		);
		// The cached entry is not an alternative, so resolution goes to the registry and the download is refused.
		expect((await h.resolve()).kind).toBe('download');
		await expect(h.run()).rejects.toMatchObject({ id: 'M-UNSIGNED' });
	});

	it('rejects a signature by an unknown key and a key the keyring revoked', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		h.registry.publish('13.0.0', {
			signers: [{ keyid: 'SHA256:stranger', privateKey: stranger.privateKey }],
		});
		await expect(h.run()).rejects.toMatchObject({ id: 'M-KEY', exitCode: 5 });

		const revoked = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
			keys: [{ keyid: 'placeholder', key: '', expires: null, revoked: true }],
		});
		revoked.context.keys = [
			{
				keyid: revoked.registry.keyid,
				key: revoked.registry.publicKeyBase64,
				expires: null,
				revoked: true,
			},
		];
		revoked.registry.publish('13.0.0');
		await expect(revoked.run()).rejects.toMatchObject({ id: 'M-UNSIGNED' });
	});

	it('judges an expired key by the publication time the registry reports', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '^13' } } });
		h.context.keys = [
			{
				keyid: h.registry.keyid,
				key: h.registry.publicKeyBase64,
				expires: '2026-06-01T00:00:00.000Z',
			},
		];
		h.registry.publish('13.0.0', { time: '2026-01-01T00:00:00.000Z' });
		expect((await h.run()).stdout).toBe('13.0.0 -v');
		const late = await start({ devEngines: { packageManager: { ...npm, version: '^13' } } });
		late.context.keys = [
			{
				keyid: late.registry.keyid,
				key: late.registry.publicKeyBase64,
				expires: '2026-06-01T00:00:00.000Z',
			},
		];
		late.registry.publish('13.0.0', { time: '2026-07-01T00:00:00.000Z' });
		await expect(late.run()).rejects.toMatchObject({ id: 'M-UNSIGNED' });
	});

	it('aborts on an unsafe tarball and publishes nothing', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0', {
			extra: [{ path: 'package/link', type: '2', linkpath: '/etc/passwd' }],
		});
		await expect(h.run()).rejects.toMatchObject({ id: 'M-INTEGRITY' });
		expect(publishedEntries(h.context.dirs.cache)).toHaveLength(0);
	});

	it('trusts the extracted manifest over the packument', async () => {
		const wrongName = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
		});
		wrongName.registry.publish('13.0.0', {
			tarball: buildTarball(npmPackageEntries('13.0.0', { name: 'not-npm' })),
		});
		await expect(wrongName.run()).rejects.toMatchObject({ id: 'M-INTEGRITY' });

		const wrongEngines = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
		});
		wrongEngines.registry.publish('13.0.0', {
			tarball: buildTarball(npmPackageEntries('13.0.0', { engines: '>=99' })),
		});
		await expect(wrongEngines.run()).rejects.toMatchObject({ id: 'M-ENGINE', exitCode: 3 });
	});

	it('keeps one entry per registry when two serve the same version with different bytes', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const first = await h.run();
		const other = new FakeRegistry();
		const server = await serveRegistry(other);
		closers.push(server.close);
		other.publish('13.0.0', { extra: [{ path: 'package/extra.txt', content: 'different' }] });
		h.context.keys = [
			...h.context.keys,
			{ keyid: other.keyid, key: other.publicKeyBase64, expires: null },
		];
		writeFileSync(
			join(h.root, 'user', '.npmrc'),
			`registry=${server.url}/\ncache=${join(h.root, 'npmcache')}\n`,
		);
		// The cached entry satisfies a plain version, so the pin names the other registry's bytes.
		const hex = Buffer.from(other.integrityOf('13.0.0').slice('sha512-'.length), 'base64').toString(
			'hex',
		);
		writeFileSync(
			join(h.project, 'package.json'),
			JSON.stringify({ packageManager: `npm@13.0.0+sha512.${hex}` }),
		);
		const { createInstaller } = await import('../../src/install/index.ts');
		const { resolveNpmWith } = await import('../../src/index.ts');
		const installer = createInstaller(h.context);
		const result = await resolveNpmWith([], h.project, { env: h.env }, installer);
		expect(result.kind).toBe('download');
		const second = await installer.ensure(result.selection!);
		second.lease.release();
		expect(second.entryPath).not.toBe(first.entryPath);
		expect(existsSync(join(second.entryPath, 'extra.txt'))).toBe(true);
		expect(existsSync(join(first.entryPath, 'extra.txt'))).toBe(false);
	});

	it("fails with exit 4 when Node's own npm is too old to download, unless the policy says warn", async () => {
		const own = {
			root: '/nowhere',
			version: '7.24.2',
			cliPath: '/nowhere/bin/npm-cli.js',
			npxCliPath: '/nowhere/bin/npx-cli.js',
		};
		const strict = await start({
			devEngines: { packageManager: { ...npm, version: '^13' } },
			own,
		});
		strict.registry.publish('13.0.0');
		await expect(strict.resolve()).rejects.toMatchObject({ id: 'M-TRANSPORT', exitCode: 4 });
		const lenient = await start({
			devEngines: { packageManager: { ...npm, version: '^13', onFail: 'warn' } },
			own,
		});
		lenient.registry.publish('13.0.0');
		expect(await lenient.resolve()).toMatchObject({
			kind: 'own',
			version: '7.24.2',
			warning: expect.stringContaining('npm 8 or newer'),
		});
	});

	it('never lets the project .npmrc or npm_config_* env reach the transport', async () => {
		const hostile = new FakeRegistry();
		const server = await serveRegistry(hostile);
		closers.push(server.close);
		hostile.publish('13.0.0', { extra: [{ path: 'package/hostile.txt', content: 'x' }] });
		const h = await start({
			devEngines: { packageManager: { ...npm, version: '13.0.0' } },
			projectFiles: { '.npmrc': `registry=${server.url}/\n//127.0.0.1/:_authToken=leak\n` },
			env: {
				npm_config_registry: `${server.url}/`,
				NPM_CONFIG_USERCONFIG: join(server.url),
				NODE_OPTIONS: '--require /nonexistent',
			},
		});
		h.registry.publish('13.0.0');
		const result = await h.run();
		expect(result.stdout).toBe('13.0.0 -v');
		expect(existsSync(join(result.entryPath, 'hostile.txt'))).toBe(false);
		expect(hostile.requests).toHaveLength(0);
		expect(
			h.registry.requests.some((request) => request.headers['authorization'] !== undefined),
		).toBe(false);
	});

	it('downloads from the configured registry even when the packument advertises another host', async () => {
		const elsewhere = new FakeRegistry();
		const server = await serveRegistry(elsewhere);
		closers.push(server.close);
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0', { tarballOrigin: server.url });
		elsewhere.publish('13.0.0', { extra: [{ path: 'package/elsewhere.txt', content: 'x' }] });
		const result = await h.run();
		expect(result.stdout).toBe('13.0.0 -v');
		expect(existsSync(join(result.entryPath, 'elsewhere.txt'))).toBe(false);
		expect(elsewhere.requests).toHaveLength(0);
		expect(h.registry.requests.some((request) => request.path.endsWith('.tgz'))).toBe(true);
	});

	it('sends the user token to the user registry and nowhere else', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.token = 'tok_123';
		writeFileSync(
			join(h.root, 'user', '.npmrc'),
			`registry=${h.registry.url}/\n//127.0.0.1:${new URL(h.registry.url).port}/:_authToken=tok_123\ncache=${join(h.root, 'npmcache')}\n`,
		);
		h.registry.publish('13.0.0');
		expect((await h.run()).stdout).toBe('13.0.0 -v');
	});
});
