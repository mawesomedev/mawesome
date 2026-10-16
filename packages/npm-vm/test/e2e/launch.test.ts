import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installedNodes, installHome, runLauncher, startLauncher } from '../helpers/launcher.ts';
import { deadOwner } from '../helpers/owners.ts';
import { readOwner } from '../../src/state/lease.ts';
import { sha256 } from '../../src/state/meta.ts';
import { createHarness, type Harness } from '../helpers/registry-harness.ts';
import { makeTree, manifest, removeTrees } from '../helpers/tree.ts';

const open: Harness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) {
		await harness.close();
	}
	removeTrees();
});

async function start(
	...args: Parameters<typeof createHarness>
): Promise<Harness & { home: string }> {
	const harness = await createHarness(...args);
	open.push(harness);
	installHome(harness.context.dirs.home);
	return { ...harness, home: harness.context.dirs.home };
}

const npm = { name: 'npm' };
let ownVersion = '';

beforeAll(async () => {
	const root = makeTree({});
	installHome(join(root, 'home'));
	const run = await runLauncher(join(root, 'home'), ['npm', '-v'], {
		cwd: root,
		env: { ...process.env, NPM_VM_HOME: join(root, 'home') },
	});
	ownVersion = run.stdout.trim();
	expect(ownVersion).toMatch(/^\d+\.\d+\.\d+/);
});

describe('launcher', { timeout: 120_000 }, () => {
	it("runs Node's own npm and npx when the project asks for nothing", async () => {
		const h = await start({});
		const npmRun = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(npmRun).toMatchObject({ status: 0, stderr: '' });
		expect(npmRun.stdout.trim()).toBe(ownVersion);
		const npxRun = await runLauncher(h.home, ['npx', '--version'], { cwd: h.project, env: h.env });
		expect(npxRun.status).toBe(0);
		expect(npxRun.stdout.trim()).toBe(ownVersion);
		expect(h.registry.requests).toHaveLength(0);
	});

	it('downloads, caches and runs the declared npm, then serves the second call offline', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const first = await runLauncher(h.home, ['npm', 'ci', '--flag'], {
			cwd: h.project,
			env: h.env,
		});
		expect(first).toMatchObject({ status: 0 });
		expect(first.stdout.trim()).toBe('13.0.0 ci --flag');
		const requests = h.registry.requests.length;
		const second = await runLauncher(h.home, ['npx', 'cowsay'], {
			cwd: h.project,
			env: { ...h.env, NPM_VM_OFFLINE: '1' },
		});
		expect(second.stdout.trim()).toBe('13.0.0 cowsay');
		expect(h.registry.requests).toHaveLength(requests);
		expect(existsSync(join(h.context.dirs.cache, 'npm'))).toBe(true);
	});

	it('propagates the exit code and prints the policy warning', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const failing = await runLauncher(h.home, ['npm', '--exit', '7'], {
			cwd: h.project,
			env: h.env,
		});
		expect(failing.status).toBe(7);
		writeFileSync(
			join(h.project, 'package.json'),
			manifest({ devEngines: { packageManager: { ...npm, version: '^99', onFail: 'warn' } } }),
		);
		const warned = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(warned.status).toBe(0);
		expect(warned.stdout.trim()).toBe(ownVersion);
		expect(warned.stderr).toContain('^99');
	});

	it('exits 3 with M-ENGINE when only an excluded version matches', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0', { engines: '>=99' });
		const run = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(run.status).toBe(3);
		expect(run.stderr).toContain('needs Node >=99');
	});

	it("global installs always use Node's own npm", async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		const run = await runLauncher(h.home, ['npm', '-g', '-v'], { cwd: h.project, env: h.env });
		expect(run.stdout.trim()).toBe(ownVersion);
		expect(h.registry.requests).toHaveLength(0);
	});

	it('serves the npm-vm CLI through the cli selector', async () => {
		const h = await start({});
		const run = await runLauncher(h.home, ['cli', 'which', '--json'], {
			cwd: h.project,
			env: h.env,
		});
		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ kind: 'own', projectRoot: h.project });
		expect(
			(
				await runLauncher(h.home, ['cli', '--version'], { cwd: h.project, env: h.env })
			).stdout.trim(),
		).toBe('0.0.0');
	});

	it('exits 6 with M-ABI for a malformed current pointer or an unsupported runtime ABI', async () => {
		const h = await start({});
		writeFileSync(join(h.home, 'current'), '../../etc\n');
		const malformed = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(malformed.status).toBe(6);
		expect(malformed.stderr).toContain('launcher mismatch');
		mkdirSync(join(h.home, 'versions', '9.9.9'), { recursive: true });
		writeFileSync(
			join(h.home, 'versions', '9.9.9', 'runtime.cjs'),
			'exports.abi = 3; exports.main = async () => 0;',
		);
		writeFileSync(join(h.home, 'current'), '9.9.9\n');
		const newer = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(newer.status).toBe(6);
		expect(newer.stderr).toContain('ABI 3');
		writeFileSync(
			join(h.home, 'versions', '9.9.9', 'runtime.cjs'),
			'exports.abi = 0; exports.main = async () => 42;',
		);
		expect((await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env })).status).toBe(
			42,
		);
	});

	it('rejects an unknown selector with 64', async () => {
		const h = await start({});
		expect((await runLauncher(h.home, ['pnpm', '-v'], { cwd: h.project, env: h.env })).status).toBe(
			64,
		);
	});

	it('the spawned npm sees its own entry path as argv[1]', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const run = await runLauncher(h.home, ['npm', '--argv1'], { cwd: h.project, env: h.env });
		expect(run.stdout.trim().replace(/\\/g, '/')).toMatch(
			/\/npm\/13\.0\.0-[0-9a-f]{16}\/bin\/npm-cli\.js$/,
		);
	});
});

describe('leftover state', { timeout: 60_000 }, () => {
	it("finishes a crashed command's journal before npm runs, and never deletes a dead owner's lock", async () => {
		const h = await start({});
		const dead = await deadOwner(h.context.dirs.machine.id);
		const journalDir = h.context.dirs.journal;
		mkdirSync(journalDir, { recursive: true });
		const target = join(h.home, 'state', 'profiles.json');
		writeFileSync(join(journalDir, 'home-0123456789abcdef.new'), '{"fixed":true}');
		writeFileSync(
			join(journalDir, 'home-0123456789abcdef.json'),
			JSON.stringify({
				id: 'home-0123456789abcdef',
				kind: 'home',
				owner: dead,
				target,
				original: {
					type: 'missing',
					mode: 0,
					sha256: null,
					encoding: null,
					lineEndings: null,
					symlinkTarget: null,
				},
				intended: sha256('{"fixed":true}'),
				staged: join(journalDir, 'home-0123456789abcdef.new'),
				backup: null,
				mode: 0o644,
				createdAt: 'now',
			}),
		);
		const run = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(run.status).toBe(0);
		expect(run.stderr).toBe('');
		expect(readFileSync(target, 'utf8')).toBe('{"fixed":true}');
		expect(existsSync(join(journalDir, 'home-0123456789abcdef.json'))).toBe(false);

		writeFileSync(
			join(journalDir, 'home-fedcba9876543210.json'),
			JSON.stringify({
				id: 'home-fedcba9876543210',
				kind: 'home',
				owner: dead,
				target,
				original: {
					type: 'missing',
					mode: 0,
					sha256: null,
					encoding: null,
					lineEndings: null,
					symlinkTarget: null,
				},
				intended: null,
				staged: null,
				backup: null,
				mode: 0o644,
				createdAt: 'now',
			}),
		);
		writeFileSync(join(h.home, 'state', 'lock'), JSON.stringify({ ...dead, token: 'crashed' }));
		const locked = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env: h.env });
		expect(locked.status).toBe(0);
		expect(locked.stdout.trim()).toBe(ownVersion);
		expect(locked.stderr).toMatch(/no longer running\. Delete .*lock and retry/);
		expect(existsSync(join(h.home, 'state', 'lock'))).toBe(true);
		expect(existsSync(join(journalDir, 'home-fedcba9876543210.json'))).toBe(true);
	});
});

describe.skipIf(process.platform === 'win32')('signals', { timeout: 60_000 }, () => {
	async function running(): Promise<{
		h: Harness & { home: string };
		child: ReturnType<typeof startLauncher>;
	}> {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const started = Promise.withResolvers<void>();
		const child = startLauncher(
			h.home,
			['npm', '--sleep'],
			{ cwd: h.project, env: h.env },
			(line) => {
				if (line.includes('sleeping')) {
					started.resolve();
				}
			},
		);
		// An early exit means the launcher never reached npm; fail with its output instead of hanging.
		await Promise.race([
			started.promise,
			child.done.then((run) => Promise.reject(new Error(`exited early: ${run.stderr}`))),
		]);
		return { h, child };
	}

	it('SIGTERM reaches npm at once and the launcher dies by the same signal', async () => {
		const { child } = await running();
		const sent = Date.now();
		child.child.kill('SIGTERM');
		const run = await child.done;
		expect(run.signal).toBe('SIGTERM');
		expect(Date.now() - sent).toBeLessThan(900);
		expect(run.stdout).toContain('got SIGTERM');
	});

	it('a running npm holds a lease in its own name beside the launcher lease', async () => {
		const { h, child } = await running();
		const entriesDir = join(h.context.dirs.cache, 'npm');
		const leasesDir = readdirSync(entriesDir).find((name) => name.endsWith('.leases')) as string;
		const owners = readdirSync(join(entriesDir, leasesDir))
			.map((name) => readOwner(join(entriesDir, leasesDir, name)))
			.map((owner) => owner?.pid);
		expect(owners).toHaveLength(2);
		expect(owners).toContain(child.child.pid);
		const npmPid = owners.find((pid) => pid !== child.child.pid) as number;
		expect(npmPid).toBeGreaterThan(0);
		// Only the launcher dies: npm keeps running under its own lease, which a prune would still see as live.
		child.child.kill('SIGKILL');
		await child.done;
		const remaining = readdirSync(join(entriesDir, leasesDir)).map(
			(name) => readOwner(join(entriesDir, leasesDir, name))?.pid,
		);
		expect(remaining).toContain(npmPid);
		process.kill(npmPid, 'SIGKILL');
	});

	it('SIGINT to the launcher alone reaches npm after about a second', async () => {
		const { child } = await running();
		const sent = Date.now();
		child.child.kill('SIGINT');
		const run = await child.done;
		expect(run.signal).toBe('SIGINT');
		const elapsed = Date.now() - sent;
		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(elapsed).toBeLessThan(5000);
		expect(run.stdout).toContain('got SIGINT');
	});

	it('npm exiting by itself does not trigger forwarding', async () => {
		const { child } = await running();
		child.child.kill('SIGHUP');
		const run = await child.done;
		expect(run.signal).toBe('SIGHUP');
	});
});

describe('other Node versions', { timeout: 120_000 }, () => {
	const nodes = installedNodes();
	const below = nodes.filter((node) => semver.lt(node.version, '22.9.0'));
	const floor = nodes.find(
		(node) => semver.gte(node.version, '22.9.0') && semver.lt(node.version, '23.0.0'),
	);

	it.runIf(process.env['NPM_VM_E2E_MANAGERS'] === '1')(
		'CI provisions Node lines below the floor, so the launcher contract is exercised',
		() => {
			expect(below.map((node) => node.version)).not.toEqual([]);
		},
	);

	it.skipIf(below.length === 0)(
		"below the floor runs Node's own npm and warns only when the project declares npm",
		async () => {
			const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
			for (const node of below) {
				const run = await runLauncher(h.home, ['npm', '--version'], {
					cwd: h.project,
					env: h.env,
					node: node.path,
				});
				expect(run.status, node.version).toBe(0);
				expect(run.stdout.trim(), node.version).toMatch(/^\d+\.\d+\.\d+/);
				expect(run.stderr, node.version).toContain('is below 22.9.0');
				const plain = makeTree({ 'package.json': manifest() });
				const quiet = await runLauncher(h.home, ['npm', '--version'], {
					cwd: plain,
					env: h.env,
					node: node.path,
				});
				expect(quiet.stderr, node.version).toBe('');
				const cli = await runLauncher(h.home, ['cli', 'which'], {
					cwd: h.project,
					env: h.env,
					node: node.path,
				});
				expect(cli.status, node.version).toBe(64);
				expect(cli.stderr, node.version).toContain('Switch to a newer Node');
				expect(cli.stderr, node.version).not.toContain('reinstall');
			}
			expect(h.registry.requests).toHaveLength(0);
		},
	);

	it.skipIf(floor === undefined)('the floor Node runs the full runtime', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0', { engines: '>=22' });
		const run = await runLauncher(h.home, ['npm', '-v'], {
			cwd: h.project,
			env: h.env,
			node: floor?.path ?? process.execPath,
		});
		expect(run.stderr).toBe('');
		expect(run.stdout.trim()).toBe('13.0.0 -v');
	});
});
