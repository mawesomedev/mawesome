import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeRegistry } from '@mawesome/testing/registry';
import { serveRegistry } from '@mawesome/testing/registry/server';
import { run, type CacheStore } from '../src/run.ts';

/** A cache that copies directories around in memory, recording the keys it saw. */
class MemoryCache implements CacheStore {
	readonly saved = new Map<string, string>();
	readonly restores: string[] = [];
	async restore(
		paths: string[],
		primaryKey: string,
		restoreKeys: string[],
	): Promise<string | undefined> {
		this.restores.push(primaryKey);
		const key = [
			primaryKey,
			...[...this.saved.keys()].filter((candidate) =>
				restoreKeys.some((prefix) => candidate.startsWith(prefix)),
			),
		].find((candidate) => this.saved.has(candidate));
		if (key === undefined) {
			return undefined;
		}
		cpSync(this.saved.get(key) as string, paths[0] as string, { recursive: true });
		return key;
	}
	async save(paths: string[], key: string): Promise<void> {
		const copy = mkdtempSync(join(tmpdir(), 'npm-use-cache-'));
		cpSync(paths[0] as string, copy, { recursive: true });
		this.saved.set(key, copy);
	}
}

/** `@actions/core` writes `name<<delimiter\nvalue\ndelimiter` blocks to GITHUB_OUTPUT. */
function parseOutputs(text: string): Record<string, string> {
	const outputs: Record<string, string> = {};
	const pattern = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
	for (const match of text.matchAll(pattern)) {
		outputs[match[1] as string] = match[3] as string;
	}
	return outputs;
}

interface World {
	root: string;
	registry: FakeRegistry;
	close(): Promise<void>;
	env: NodeJS.ProcessEnv;
	outputs(): Record<string, string>;
	path(): string;
}

const worlds: World[] = [];
let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
	savedEnv = { ...process.env };
});

afterEach(async () => {
	const finished = worlds.splice(0);
	await Promise.all(finished.map((entry) => entry.close()));
	for (const entry of finished) {
		rmSync(entry.root, { recursive: true, force: true });
	}
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, savedEnv);
});

async function world(
	devEngines: unknown,
	inputs: Record<string, string> = {},
	shared?: World,
): Promise<World> {
	// A later world may share the registry of an earlier one, as CI runs share one registry across jobs.
	const registry = shared?.registry ?? new FakeRegistry();
	const server =
		shared === undefined
			? await serveRegistry(registry)
			: { url: registry.url, close: async () => undefined };
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-use-action-')));
	for (const dir of ['temp', 'user', 'project', 'cache', 'prefix']) {
		mkdirSync(join(root, dir));
	}
	writeFileSync(
		join(root, 'user', '.npmrc'),
		`registry=${server.url}/\ncache=${join(root, 'npmcache')}\n`,
	);
	writeFileSync(join(root, 'project', 'package.json'), JSON.stringify({ name: 'p', devEngines }));
	mkdirSync(join(root, 'temp', 'npm-use', 'home', 'state'), { recursive: true });
	writeFileSync(
		join(root, 'temp', 'npm-use', 'home', 'state', 'keys.json'),
		JSON.stringify([{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: null }]),
	);
	writeFileSync(join(root, 'output.txt'), '');
	writeFileSync(join(root, 'path.txt'), '');
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(savedEnv)) {
		if (
			!/^npm_/i.test(key) &&
			!/proxy$/i.test(key) &&
			!key.startsWith('NPM_USE_') &&
			!key.startsWith('INPUT_')
		) {
			env[key] = value;
		}
	}
	Object.assign(env, {
		HOME: join(root, 'user'),
		PREFIX: join(root, 'prefix'),
		XDG_CACHE_HOME: join(root, 'cache'),
		RUNNER_TEMP: join(root, 'temp'),
		RUNNER_OS: 'TestOS',
		GITHUB_OUTPUT: join(root, 'output.txt'),
		GITHUB_PATH: join(root, 'path.txt'),
		INPUT_CACHE: 'true',
		'INPUT_WORKING-DIRECTORY': join(root, 'project'),
		...Object.fromEntries(
			Object.entries(inputs).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]),
		),
	});
	// @actions/core reads inputs and output paths from the process env.
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('INPUT_') || key.startsWith('GITHUB_') || key.startsWith('NPM_USE_')) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, env);
	const created: World = {
		root,
		registry,
		close: server.close,
		env,
		outputs: () => parseOutputs(readFileSync(join(root, 'output.txt'), 'utf8')),
		path: () => readFileSync(join(root, 'path.txt'), 'utf8').trim(),
	};
	worlds.push(created);
	return created;
}

describe('npm-use action', { timeout: 120_000 }, () => {
	it('cold: downloads, verifies, saves the tarball, and puts the shims on PATH', async () => {
		const w = await world({ packageManager: { name: 'npm', version: '13.0.0' } });
		w.registry.publish('13.0.0');
		const cache = new MemoryCache();
		await run({ cache, env: w.env, cwd: w.root });
		expect(w.outputs()).toMatchObject({
			version: '13.0.0',
			kind: 'download',
			'cache-hit': 'false',
		});
		expect(w.outputs()['cli-path']).toMatch(/npm-cli\.js$/);
		expect(w.path()).toBe(join(w.root, 'temp', 'npm-use', 'home', 'shims'));
		expect([...cache.saved.keys()]).toHaveLength(1);
		const key = [...cache.saved.keys()][0] as string;
		expect(key).toMatch(/^npm-use-v1-TestOS-node/);
		expect(existsSync(join(cache.saved.get(key) as string, 'npm-13.0.0.tgz'))).toBe(true);
	});

	it('warm: restores the tarball, re-verifies it, and never asks the registry for it', async () => {
		const first = await world({ packageManager: { name: 'npm', version: '^13' } });
		first.registry.publish('13.0.0');
		const cache = new MemoryCache();
		await run({ cache, env: first.env, cwd: first.root });

		const second = await world({ packageManager: { name: 'npm', version: '^13' } }, {}, first);
		const before = second.registry.requests.length;
		await run({ cache, env: second.env, cwd: second.root });
		expect(second.outputs()).toMatchObject({
			version: '13.0.0',
			kind: 'download',
			'cache-hit': 'true',
		});
		expect(
			second.registry.requests.slice(before).filter((request) => request.path.endsWith('.tgz')),
		).toHaveLength(0);
	});

	it('offline: a restored tarball still works, and one that no longer fits is replaced', async () => {
		const first = await world({ packageManager: { name: 'npm', version: '^13' } });
		first.registry.publish('13.0.0');
		const cache = new MemoryCache();
		await run({ cache, env: first.env, cwd: first.root });

		const offline = await world({ packageManager: { name: 'npm', version: '^13' } }, {}, first);
		await run({ cache, env: { ...offline.env, NPM_USE_OFFLINE: '1' }, cwd: offline.root });
		expect(offline.outputs()).toMatchObject({ version: '13.0.0', 'cache-hit': 'true' });

		const moved = await world({ packageManager: { name: 'npm', version: '^13.1.0' } }, {}, first);
		moved.registry.publish('13.1.0');
		await run({ cache, env: moved.env, cwd: moved.root });
		expect(moved.outputs()).toMatchObject({
			version: '13.1.0',
			kind: 'download',
			'cache-hit': 'false',
		});
		expect([...cache.saved.keys()]).toHaveLength(2);
	});

	it("uses Node's own npm without touching the cache when it satisfies the project", async () => {
		const w = await world({ packageManager: { name: 'npm', version: '>=8' } });
		const cache = new MemoryCache();
		await run({ cache, env: w.env, cwd: w.root });
		expect(w.outputs()).toMatchObject({ kind: 'own', 'cache-hit': 'false' });
		expect(cache.restores).toHaveLength(0);
		expect(w.registry.requests).toHaveLength(0);
	});

	it('honours the version input over the project', async () => {
		const w = await world(
			{ packageManager: { name: 'npm', version: '>=8' } },
			{ version: '13.0.0' },
		);
		w.registry.publish('13.0.0');
		await run({ cache: new MemoryCache(), env: w.env, cwd: w.root });
		expect(w.outputs()).toMatchObject({ version: '13.0.0', kind: 'download' });
	});
});
