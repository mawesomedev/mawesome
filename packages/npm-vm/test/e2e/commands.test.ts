import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTarball, type TarEntry } from '@mawesome/testing/registry/tar';
import { SLSA_PREDICATE } from '../../src/install/provenance.ts';
import { selfUpdate } from '../../src/commands/self-update.ts';
import { createCommandContext } from '../../src/commands/context.ts';
import { command } from '../helpers/commands.ts';
import { DIST_RUNTIME, installHome, runLauncher } from '../helpers/launcher.ts';
import { deadOwner, liveOwner } from '../helpers/owners.ts';
import { acquireLock } from '../../src/state/lock.ts';
import { createHarness, type Harness } from '../helpers/registry-harness.ts';
import { makeTree, manifest, removeTrees } from '../helpers/tree.ts';
import { readCurrent, readPrevious } from '../../src/setup/layout.ts';
import { sha256 } from '../../src/state/meta.ts';

const open: Harness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) {
		await harness.close();
	}
	removeTrees();
});

const WIN = process.platform === 'win32';
/* Windows would default to PowerShell and the registry PATH; these tests target the zsh files under HOME and leave the registry alone. */
const SETUP = WIN ? ['--shell', 'zsh', '--no-user-path'] : [];

async function start(
	...args: Parameters<typeof createHarness>
): Promise<Harness & { home: string }> {
	const harness = await createHarness(...args);
	open.push(harness);
	const home = harness.context.dirs.home;
	if (WIN) {
		// doctor asks cmd and PowerShell what PATH resolves; the shims must already be first there.
		const key = Object.keys(harness.env).find((name) => name.toLowerCase() === 'path') ?? 'Path';
		harness.env[key] = `${join(home, 'shims')};${harness.env[key] ?? ''}`;
	}
	return { ...harness, home };
}

const npm = { name: 'npm' };

describe('setup, doctor and uninstall', { timeout: 120_000 }, () => {
	it('installs the runtime and shims, edits the consented profile, and doctor is healthy', async () => {
		const h = await start({});
		writeFileSync(join(h.root, 'user', '.zshrc'), 'eval "$(fnm env)"\n');
		const env = { ...h.env, SHELL: '/bin/zsh', ZDOTDIR: join(h.root, 'user') };
		rmSync(h.home, { recursive: true, force: true });
		const dry = await command(['setup', ...SETUP, '--dry-run'], {
			home: h.home,
			env,
			cwd: h.project,
		});
		expect(dry.code).toBe(0);
		expect(existsSync(h.home)).toBe(false);
		expect(readFileSync(join(h.root, 'user', '.zshrc'), 'utf8')).not.toContain('npm-vm');

		const declined = await command(['setup', ...SETUP], {
			home: h.home,
			env,
			cwd: h.project,
			answers: [false, false],
		});
		expect(declined.code).toBe(0);
		expect(declined.questions).toHaveLength(2);
		expect(declined.stdout).toContain('Add this yourself');
		expect(readFileSync(join(h.root, 'user', '.zshrc'), 'utf8')).not.toContain('npm-vm');
		expect(existsSync(join(h.home, 'shims', 'npm'))).toBe(true);
		expect(
			(await command(['setup', ...SETUP, '--strict'], { home: h.home, env, cwd: h.project })).code,
		).toBe(2);

		const yes = await command(['setup', ...SETUP, '--yes'], { home: h.home, env, cwd: h.project });
		expect(yes.code).toBe(0);
		expect(readFileSync(join(h.root, 'user', '.zshrc'), 'utf8')).toContain('_npm_vm_guard');
		expect(readFileSync(join(h.root, 'user', '.zshenv'), 'utf8')).toContain('shims');
		expect(readCurrent(h.home)).toBe('0.0.0');
		const launched = await runLauncher(h.home, ['npm', '-v'], { cwd: h.project, env });
		expect(launched.status).toBe(0);

		const again = await command(['setup', ...SETUP, '--yes', '--json'], {
			home: h.home,
			env,
			cwd: h.project,
		});
		expect(JSON.parse(again.stdout)).toMatchObject({
			profiles: [{ outcome: 'unchanged' }, { outcome: 'unchanged' }],
		});
		expect(
			readdirSync(join(h.root, 'user')).filter((name) => name.includes('npm-vm-backup')),
		).toHaveLength(1);

		const healthy = await command(['doctor', '--json'], {
			home: h.home,
			env: { ...env, SHELL: '/nonexistent/shell' },
			cwd: h.project,
		});
		expect(healthy.code, healthy.stdout).toBe(0);
		expect(JSON.parse(healthy.stdout)).toMatchObject({ version: '0.0.0', problems: [] });

		writeFileSync(join(h.home, 'shims', 'npx'), '#!/bin/sh\nexit 1\n');
		const sick = await command(['doctor', '--json'], {
			home: h.home,
			env: { ...env, SHELL: '/nonexistent/shell' },
			cwd: h.project,
		});
		expect(sick.code).toBe(1);
		expect(JSON.parse(sick.stdout).problems).toMatchObject([{ check: 'shims' }]);

		const removed = await command(['uninstall', '--yes'], { home: h.home, env, cwd: h.project });
		expect(removed.code).toBe(0);
		expect(readFileSync(join(h.root, 'user', '.zshrc'), 'utf8')).toBe('eval "$(fnm env)"\n');
		expect(existsSync(join(h.root, 'user', '.zshenv'))).toBe(false);
		expect(existsSync(h.home)).toBe(false);
		expect(existsSync(h.context.dirs.cache)).toBe(true);
	});

	it('prints the snippet instead of editing a symlinked profile and reports it under --strict', async () => {
		const h = await start({});
		writeFileSync(join(h.root, 'user', 'real-zshrc'), '');
		const { symlinkSync } = await import('node:fs');
		symlinkSync(join(h.root, 'user', 'real-zshrc'), join(h.root, 'user', '.zshrc'));
		const env = { ...h.env, SHELL: '/bin/zsh', ZDOTDIR: join(h.root, 'user') };
		const result = await command(['setup', ...SETUP, '--yes', '--strict'], {
			home: h.home,
			env,
			cwd: h.project,
		});
		expect(result.code).toBe(2);
		expect(result.stdout).toContain('symlink');
		expect(readFileSync(join(h.root, 'user', 'real-zshrc'), 'utf8')).toBe('');
	});

	it('links every nvm install and uninstall restores it', async () => {
		const h = await start({});
		const nvmDir = join(h.root, 'nvm');
		const bin = join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin');
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho original npm\n');
		writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho original npx\n');
		const env = { ...h.env, NVM_DIR: nvmDir, SHELL: '/bin/zsh', ZDOTDIR: join(h.root, 'user') };
		const result = await command(
			['setup', ...SETUP, '--link', '--yes', '--no-modify-profile', '--json'],
			{
				home: h.home,
				env,
				cwd: h.project,
			},
		);
		expect(result.code).toBe(0);
		expect(readFileSync(join(bin, 'npm'), 'utf8')).toContain('bootstrap.cjs');
		expect(readFileSync(join(bin, 'npm.npm-vm-original'), 'utf8')).toContain('original npm');
		const doctor = await command(['doctor', '--json'], {
			home: h.home,
			env: { ...env, SHELL: '/nonexistent/shell' },
			cwd: h.project,
		});
		expect(JSON.parse(doctor.stdout).problems).toEqual([]);
		writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho npm 11 replaced me\n');
		const changed = await command(['doctor', '--json'], {
			home: h.home,
			env: { ...env, SHELL: '/nonexistent/shell' },
			cwd: h.project,
		});
		expect(JSON.parse(changed.stdout).problems).toMatchObject([{ check: 'link' }]);
		const removed = await command(['uninstall', '--yes'], { home: h.home, env, cwd: h.project });
		expect(removed.code).toBe(1);
		expect(readFileSync(join(bin, 'npm'), 'utf8')).toContain('original npm');
		expect(readFileSync(join(bin, 'npx'), 'utf8')).toContain('replaced me');
	});
});

describe('mutation safety', { timeout: 60_000 }, () => {
	it('pin waits for the exclusive lock and keeps the manifest mode', async () => {
		const h = await start({});
		const file = join(h.project, 'package.json');
		chmodSync(file, 0o600);
		const held = await acquireLock(h.context.dirs.state, liveOwner());
		let releasedAt = 0;
		setTimeout(() => {
			releasedAt = Date.now();
			held.release();
		}, 300);
		const startedAt = Date.now();
		const pinned = await command(['pin', '^12'], { home: h.home, env: h.env, cwd: h.project });
		expect(pinned.code).toBe(0);
		expect(releasedAt).toBeGreaterThan(startedAt);
		expect(Date.now()).toBeGreaterThanOrEqual(releasedAt);
		expect(JSON.parse(readFileSync(file, 'utf8')).devEngines.packageManager.version).toBe('^12');
		if (process.platform !== 'win32') {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it('uninstall --purge-cache keeps an entry a running npm holds', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		const result = await h.resolve();
		if (result.selection === null) {
			throw new Error(`expected a download, got ${result.kind}`);
		}
		const { entryPath, lease } = await h.installer.ensure(result.selection);
		try {
			const removed = await command(['uninstall', '--yes', '--purge-cache', '--json'], {
				home: h.home,
				env: h.env,
				cwd: h.project,
			});
			expect(removed.code).toBe(1);
			expect(JSON.parse(removed.stdout)).toMatchObject({
				cacheRemoved: false,
				cacheKept: [basename(entryPath)],
			});
			expect(existsSync(join(entryPath, 'bin', 'npm-cli.js'))).toBe(true);
		} finally {
			lease.release();
		}
	});
});

describe('pin', { timeout: 60_000 }, () => {
	it('writes the object form, keeps other managers, preserves formatting, and refuses a workspace member', async () => {
		const h = await start({});
		writeFileSync(
			join(h.project, 'package.json'),
			'{\n    "name": "p",\n    "version": "1.0.0"\n}\n',
		);
		expect(
			(await command(['pin', '^12.0.0'], { home: h.home, env: h.env, cwd: h.project })).code,
		).toBe(0);
		expect(readFileSync(join(h.project, 'package.json'), 'utf8')).toBe(
			'{\n    "name": "p",\n    "version": "1.0.0",\n    "devEngines": {\n        "packageManager": {\n            "name": "npm",\n            "version": "^12.0.0",\n            "onFail": "error"\n        }\n    }\n}\n',
		);
		writeFileSync(
			join(h.project, 'package.json'),
			manifest({ devEngines: { packageManager: { name: 'pnpm', version: '^10' } } }),
		);
		await command(['pin', '12.x'], { home: h.home, env: h.env, cwd: h.project });
		expect(
			JSON.parse(readFileSync(join(h.project, 'package.json'), 'utf8')).devEngines.packageManager,
		).toEqual([
			{ name: 'pnpm', version: '^10' },
			{ name: 'npm', version: '12.x', onFail: 'error' },
		]);
		expect(
			(await command(['pin', 'latest'], { home: h.home, env: h.env, cwd: h.project })).code,
		).toBe(64);

		const workspace = makeTree({
			'package.json': manifest({ workspaces: ['packages/*'] }),
			packages: { a: { 'package.json': manifest({ name: 'a' }) } },
		});
		const refused = await command(['pin', '^12'], {
			home: h.home,
			env: h.env,
			cwd: join(workspace, 'packages', 'a'),
		});
		expect(refused.code).toBe(64);
		expect(refused.stderr).toContain('workspace');
	});

	it('defaults to the newest release that supports this Node', async () => {
		const h = await start({});
		h.registry.publish('13.0.0', { engines: '>=22' });
		h.registry.publish('13.1.0', { engines: '>=99' });
		expect((await command(['pin'], { home: h.home, env: h.env, cwd: h.project })).code).toBe(0);
		expect(
			JSON.parse(readFileSync(join(h.project, 'package.json'), 'utf8')).devEngines.packageManager
				.version,
		).toBe('^13.0.0');
	});
});

describe('install, cache and recover', { timeout: 120_000 }, () => {
	it('installs by spec, lists, prunes by age and keeps entries in use', async () => {
		const h = await start({ devEngines: { packageManager: { ...npm, version: '13.0.0' } } });
		h.registry.publish('13.0.0');
		h.registry.publish('13.1.0');
		expect((await command(['install'], { home: h.home, env: h.env, cwd: h.project })).code).toBe(0);
		expect(
			(await command(['install', '13.1.0'], { home: h.home, env: h.env, cwd: h.project })).code,
		).toBe(0);
		const list = await command(['cache', 'list', '--json'], {
			home: h.home,
			env: h.env,
			cwd: h.project,
		});
		expect(
			JSON.parse(list.stdout).entries.map((entry: { version: string }) => entry.version),
		).toEqual(['13.0.0', '13.1.0']);
		const kept = await command(['cache', 'prune', '--json'], {
			home: h.home,
			env: h.env,
			cwd: h.project,
		});
		expect(JSON.parse(kept.stdout)).toMatchObject({
			removed: [],
			kept: expect.arrayContaining([expect.stringContaining('13.0.0')]),
		});
		const pruned = await command(['cache', 'prune', '--older-than', '0', '--json'], {
			home: h.home,
			env: h.env,
			cwd: h.project,
		});
		expect(JSON.parse(pruned.stdout).removed).toHaveLength(2);
		expect(
			(
				await command(['cache', 'prune', '--older-than', 'soon'], {
					home: h.home,
					env: h.env,
					cwd: h.project,
				})
			).code,
		).toBe(64);
	});

	it('recovers a foreign journal only with the confirmed machine id', async () => {
		const h = await start({});
		installHome(h.home);
		const dead = await deadOwner('build-box');
		mkdirSync(h.context.dirs.journal, { recursive: true });
		const target = join(h.root, 'target.txt');
		writeFileSync(join(h.context.dirs.journal, 'home-0123456789abcdef.new'), 'fixed');
		writeFileSync(
			join(h.context.dirs.journal, 'home-0123456789abcdef.json'),
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
				intended: sha256('fixed'),
				staged: join(h.context.dirs.journal, 'home-0123456789abcdef.new'),
				backup: null,
				mode: 0o644,
				createdAt: 'now',
			}),
		);
		const doctor = await command(['doctor', '--json'], {
			home: h.home,
			env: { ...h.env, SHELL: '/nonexistent/shell' },
			cwd: h.project,
		});
		expect(
			JSON.parse(doctor.stdout).problems.filter(
				(problem: { check: string }) => problem.check === 'journal',
			),
		).toMatchObject([{ fix: expect.stringContaining('--confirm-dead-machine build-box') }]);
		expect(
			(
				await command(
					['recover', '--journal', 'home-0123456789abcdef', '--confirm-dead-machine', 'wrong'],
					{ home: h.home, env: h.env, cwd: h.project },
				)
			).code,
		).toBe(64);
		expect(existsSync(target)).toBe(false);
		const ok = await command(
			['recover', '--journal', 'home-0123456789abcdef', '--confirm-dead-machine', 'build-box'],
			{ home: h.home, env: h.env, cwd: h.project },
		);
		expect(ok.code).toBe(0);
		expect(readFileSync(target, 'utf8')).toBe('fixed');
	});
});

/** A release tarball of @mawesome/npm-vm whose runtime answers `--version` with `version` and declares `abi`. */
function releaseTarball(version: string, abi: number): Buffer {
	const bootstrap = readFileSync(join(DIST_RUNTIME, 'bootstrap.cjs'), 'utf8').replace(
		'LAUNCHER_ABI = 1',
		`LAUNCHER_ABI = ${abi}`,
	);
	const runtime = `exports.abi = ${abi}; exports.main = async (selector, args) => { if (args[0] === '--version') { console.log('${version}'); return 0; } return 7; };`;
	const entries: TarEntry[] = [
		{ path: 'package/', type: '5' },
		{
			path: 'package/package.json',
			content: JSON.stringify({ name: '@mawesome/npm-vm', version }),
		},
		{ path: 'package/dist/runtime/runtime.cjs', content: runtime },
		{ path: 'package/dist/runtime/bootstrap.cjs', content: bootstrap },
	];
	for (const kind of ['sh', 'cmd', 'ps1']) {
		entries.push({
			path: `package/dist/runtime/launchers/${kind}.tmpl`,
			content: readFileSync(join(DIST_RUNTIME, 'launchers', `${kind}.tmpl`), 'utf8'),
		});
	}
	return buildTarball(entries);
}

function attestationFor(version: string, tarball: Buffer): unknown {
	const statement = {
		subject: [
			{
				name: `pkg:npm/%40mawesome/npm-vm@${version}`,
				digest: { sha512: createHash('sha512').update(tarball).digest('hex') },
			},
		],
		predicateType: SLSA_PREDICATE,
	};
	return {
		predicateType: SLSA_PREDICATE,
		bundle: {
			dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
		},
	};
}

async function updateContext(h: Harness & { home: string }) {
	installHome(h.home);
	await command(['setup', ...SETUP, '--yes', '--no-modify-profile'], {
		home: h.home,
		env: h.env,
		cwd: h.project,
	});
	return createCommandContext({
		home: h.home,
		env: h.env,
		version: '0.0.0',
		io: {
			out: () => undefined,
			err: () => undefined,
			interactive: false,
			confirm: async () => false,
		},
	});
}

describe('self-update', { timeout: 120_000 }, () => {
	it('updates forward only, verifies provenance, and rolls back offline', async () => {
		const h = await start({});
		const ctx = await updateContext(h);
		const verifier = { calls: 0 };
		const deps = {
			verifyBundle: async () => {
				verifier.calls += 1;
			},
		};
		const older = releaseTarball('0.0.0', 1);
		h.registry.publishPackage('@mawesome/npm-vm', '0.0.0', {
			tarball: older,
			attestations: [attestationFor('0.0.0', older)],
		});
		expect(await selfUpdate(ctx, { rollback: false }, deps)).toBe(0);
		expect(readCurrent(h.home)).toBe('0.0.0');
		expect(verifier.calls).toBe(0);

		const next = releaseTarball('0.1.0', 1);
		h.registry.publishPackage('@mawesome/npm-vm', '0.1.0', {
			tarball: next,
			attestations: [attestationFor('0.1.0', next)],
		});
		expect(await selfUpdate(ctx, { rollback: false }, deps)).toBe(0);
		expect(verifier.calls).toBe(1);
		expect(readCurrent(h.home)).toBe('0.1.0');
		expect(readPrevious(h.home)).toBe('0.0.0');
		const launched = await runLauncher(h.home, ['cli', '--version'], {
			cwd: h.project,
			env: h.env,
		});
		expect(launched.stdout.trim()).toBe('0.1.0');

		expect(await selfUpdate(ctx, { rollback: true })).toBe(0);
		expect(readCurrent(h.home)).toBe('0.0.0');
		expect(
			(
				await runLauncher(h.home, ['cli', '--version'], { cwd: h.project, env: h.env })
			).stdout.trim(),
		).toBe('0.0.0');
	});

	it('refuses a release without provenance and one failing its health check, leaving current unchanged', async () => {
		const h = await start({});
		const ctx = await updateContext(h);
		const unattested = releaseTarball('0.2.0', 1);
		h.registry.publishPackage('@mawesome/npm-vm', '0.2.0', { tarball: unattested });
		await expect(
			selfUpdate(ctx, { rollback: false }, { verifyBundle: async () => undefined }),
		).rejects.toMatchObject({ id: 'M-PROVENANCE', exitCode: 5 });
		expect(readCurrent(h.home)).toBe('0.0.0');

		const broken = releaseTarball('0.3.0-wrong', 1);
		h.registry.publishPackage('@mawesome/npm-vm', '0.3.0', {
			tarball: broken,
			attestations: [attestationFor('0.3.0', broken)],
		});
		await expect(
			selfUpdate(ctx, { rollback: false }, { verifyBundle: async () => undefined }),
		).rejects.toMatchObject({ id: 'M-ABI' });
		expect(readCurrent(h.home)).toBe('0.0.0');
		expect(existsSync(join(h.home, 'versions', '0.3.0'))).toBe(false);
	});

	it('replaces the launchers on an ABI change and refuses a skipped generation', async () => {
		const h = await start({});
		const ctx = await updateContext(h);
		const next = releaseTarball('0.4.0', 2);
		h.registry.publishPackage('@mawesome/npm-vm', '0.4.0', {
			tarball: next,
			attestations: [attestationFor('0.4.0', next)],
		});
		expect(
			await selfUpdate(ctx, { rollback: false }, { verifyBundle: async () => undefined }),
		).toBe(0);
		expect(readFileSync(join(h.home, 'shims', 'npm'), 'utf8')).toContain('abi=2');
		expect(readFileSync(join(h.home, 'bootstrap.cjs'), 'utf8')).toContain('LAUNCHER_ABI = 2');
		expect(
			(
				await runLauncher(h.home, ['cli', '--version'], { cwd: h.project, env: h.env })
			).stdout.trim(),
		).toBe('0.4.0');
		expect(await selfUpdate(ctx, { rollback: true })).toBe(0);
		expect(readFileSync(join(h.home, 'shims', 'npm'), 'utf8')).toContain('abi=1');
		expect(
			(
				await runLauncher(h.home, ['cli', '--version'], { cwd: h.project, env: h.env })
			).stdout.trim(),
		).toBe('0.0.0');

		const far = releaseTarball('0.5.0', 3);
		h.registry.publishPackage('@mawesome/npm-vm', '0.5.0', {
			tarball: far,
			attestations: [attestationFor('0.5.0', far)],
		});
		await expect(
			selfUpdate(ctx, { rollback: false }, { verifyBundle: async () => undefined }),
		).rejects.toMatchObject({ id: 'M-ABI', exitCode: 6 });
		expect(readCurrent(h.home)).toBe('0.0.0');
	});
});
