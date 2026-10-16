import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
	rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDirs } from '../../src/setup/home.ts';
import {
	findNodeInstalls,
	linkOne,
	linkState,
	linkTargets,
	readLinks,
	unlinkOne,
	writeLinks,
} from '../../src/setup/link.ts';
import { ownerRecord } from '../../src/state/lease.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

const owner = ownerRecord('m');

function fakeNvm(root: string, versions: string[]): string {
	const nvmDir = join(root, '.nvm');
	for (const version of versions) {
		const bin = join(nvmDir, 'versions', 'node', `v${version}`, 'bin');
		const lib = join(
			nvmDir,
			'versions',
			'node',
			`v${version}`,
			'lib',
			'node_modules',
			'npm',
			'bin',
		);
		for (const dir of [bin, lib]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(join(lib, 'npm-cli.js'), '');
		writeFileSync(join(lib, 'npx-cli.js'), '');
		symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'));
		symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(bin, 'npx'));
	}
	return nvmDir;
}

describe('findNodeInstalls', () => {
	it('lists nvm and fnm installs once each', () => {
		const root = makeTree({
			fnm: { 'node-versions': { 'v22.0.0': { installation: { bin: {} } }, junk: {} } },
		});
		const nvmDir = fakeNvm(root, ['24.0.0', '22.0.0']);
		const installs = findNodeInstalls(
			{ NVM_DIR: nvmDir, FNM_DIR: join(root, 'fnm') },
			'linux',
			root,
		);
		expect(installs.map((install) => `${install.manager}:${install.version}`).toSorted()).toEqual([
			'fnm:22.0.0',
			'nvm:22.0.0',
			'nvm:24.0.0',
		]);
	});
});

describe('link and unlink', () => {
	it('replaces the symlinks with shims, is idempotent, and restores on unlink', () => {
		const root = makeTree({ home: {} });
		const nvmDir = fakeNvm(root, ['24.0.0']);
		const dirs = resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
		const binDir = join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin');
		const targets = linkTargets(join(root, 'home'), 'linux', true);
		expect(targets.map((target) => target.name)).toEqual(['npm', 'npx']);
		const first = targets.map((target) => linkOne(dirs, owner, binDir, target));
		expect(first.map((result) => result.outcome)).toEqual(['linked', 'linked']);
		expect(lstatSync(join(binDir, 'npm')).isFile()).toBe(true);
		expect(readFileSync(join(binDir, 'npm'), 'utf8')).toContain('bootstrap.cjs');
		expect(lstatSync(join(binDir, 'npm.npm-vm-original')).isSymbolicLink()).toBe(true);
		expect(readLinks(dirs).entries).toHaveLength(2);

		const again = targets.map((target) => linkOne(dirs, owner, binDir, target));
		expect(again.map((result) => result.outcome)).toEqual(['already', 'already']);
		expect(readLinks(dirs).entries).toHaveLength(2);

		for (const entry of readLinks(dirs).entries) {
			expect(linkState(entry)).toBe('intact');
			expect(unlinkOne(dirs, owner, entry)).toBe('restored');
		}
		expect(lstatSync(join(binDir, 'npm')).isSymbolicLink()).toBe(true);
		expect(existsSync(join(binDir, 'npm.npm-vm-original'))).toBe(false);
		expect(readLinks(dirs).entries).toEqual([]);
	});

	it('never overwrites a file it does not recognise and leaves a replaced shim in place', () => {
		const root = makeTree({ home: {} });
		const nvmDir = fakeNvm(root, ['24.0.0']);
		const dirs = resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
		const binDir = join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin');
		const [npm] = linkTargets(join(root, 'home'), 'linux', true);
		writeFileSync(join(binDir, 'npm.npm-vm-original'), 'leftover');
		expect(linkOne(dirs, owner, binDir, npm!)).toMatchObject({ outcome: 'foreign' });
		expect(lstatSync(join(binDir, 'npm')).isSymbolicLink()).toBe(true);

		// `npm i -g npm@11` replaced our shim: doctor sees it, uninstall leaves it.
		const fresh = makeTree({ home: {} });
		const freshNvm = fakeNvm(fresh, ['24.0.0']);
		const freshDirs = resolveDirs({}, join(fresh, 'home'), 'linux', { id: 'm', fallback: false });
		const freshBin = join(freshNvm, 'versions', 'node', 'v24.0.0', 'bin');
		const [freshNpm] = linkTargets(join(fresh, 'home'), 'linux', true);
		expect(linkOne(freshDirs, owner, freshBin, freshNpm!).outcome).toBe('linked');
		writeFileSync(join(freshBin, 'npm'), '#!/bin/sh\nexec node npm-11\n');
		const entry = readLinks(freshDirs).entries[0]!;
		expect(linkState(entry)).toBe('changed');
		expect(unlinkOne(freshDirs, owner, entry)).toBe('changed');
		expect(readFileSync(join(freshBin, 'npm'), 'utf8')).toContain('npm-11');
		expect(linkOne(freshDirs, owner, freshBin, freshNpm!).outcome).toBe('foreign');
		expect(existsSync(join(freshBin, 'npm.npm-vm-original'))).toBe(true);
	});

	it('rewrites a changed shim in place, keeps the original, and recovers a crash that left the target missing', () => {
		const root = makeTree({ home: {} });
		const nvmDir = fakeNvm(root, ['24.0.0']);
		const dirs = resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
		const binDir = join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin');
		const [npm] = linkTargets(join(root, 'home'), 'linux', true);
		expect(linkOne(dirs, owner, binDir, npm!).outcome).toBe('linked');
		// A new template: the shim is replaced, the preserved original is untouched.
		expect(
			linkOne(dirs, owner, binDir, { ...npm!, content: `${npm!.content}# v2\n` }).outcome,
		).toBe('linked');
		expect(readFileSync(join(binDir, 'npm'), 'utf8')).toContain('# v2');
		expect(lstatSync(join(binDir, 'npm.npm-vm-original')).isSymbolicLink()).toBe(true);
		expect(readLinks(dirs).entries).toHaveLength(1);
		// A crash after moving the original aside: the next link and the next unlink both restore it first.
		rmSync(join(binDir, 'npm'));
		expect(linkOne(dirs, owner, binDir, npm!).outcome).toBe('linked');
		expect(readFileSync(join(binDir, 'npm'), 'utf8')).toBe(npm!.content);
		rmSync(join(binDir, 'npm'));
		expect(unlinkOne(dirs, owner, readLinks(dirs).entries[0]!)).toBe('restored');
		expect(lstatSync(join(binDir, 'npm')).isSymbolicLink()).toBe(true);
		expect(existsSync(join(binDir, 'npm.npm-vm-original'))).toBe(false);
	});

	it('moves a blocked .ps1 aside and puts it back on unlink', () => {
		const root = makeTree({
			home: {},
			bin: {
				'npm.ps1': 'original ps1',
				'npx.ps1': 'x',
				npm: 'n',
				npx: 'x',
				'npm.cmd': 'c',
				'npx.cmd': 'c',
			},
		});
		const dirs = resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
		const ps1 = linkTargets(join(root, 'home'), 'win32', false).find(
			(target) => target.name === 'npm.ps1',
		)!;
		expect(ps1.content).toBeNull();
		expect(linkOne(dirs, owner, join(root, 'bin'), ps1).outcome).toBe('linked');
		expect(existsSync(join(root, 'bin', 'npm.ps1'))).toBe(false);
		expect(readFileSync(join(root, 'bin', 'npm.ps1.npm-vm-original'), 'utf8')).toBe('original ps1');
		expect(linkOne(dirs, owner, join(root, 'bin'), ps1).outcome).toBe('already');
		const entry = readLinks(dirs).entries.find((item) => item.name === 'npm.ps1')!;
		expect(linkState(entry)).toBe('intact');
		// A crash between the rename and the record: the aside file is adopted on the next run.
		writeLinks(dirs, {
			version: 1,
			entries: readLinks(dirs).entries.filter((item) => item.name !== 'npm.ps1'),
		});
		expect(linkOne(dirs, owner, join(root, 'bin'), ps1).outcome).toBe('already');
		expect(readLinks(dirs).entries.some((item) => item.name === 'npm.ps1')).toBe(true);
		// The policy turned restrictive after a permissive link: our .ps1 shim goes, the original stays aside.
		const permissive = linkTargets(join(root, 'home'), 'win32', true).find(
			(target) => target.name === 'npx.ps1',
		)!;
		expect(linkOne(dirs, owner, join(root, 'bin'), permissive).outcome).toBe('linked');
		expect(readFileSync(join(root, 'bin', 'npx.ps1'), 'utf8')).toContain('bootstrap.cjs');
		const restricted = linkTargets(join(root, 'home'), 'win32', false).find(
			(target) => target.name === 'npx.ps1',
		)!;
		expect(linkOne(dirs, owner, join(root, 'bin'), restricted).outcome).toBe('linked');
		expect(existsSync(join(root, 'bin', 'npx.ps1'))).toBe(false);
		expect(readFileSync(join(root, 'bin', 'npx.ps1.npm-vm-original'), 'utf8')).toBe('x');
		// Permissive again: the shim returns while the original stays aside for unlink.
		expect(linkOne(dirs, owner, join(root, 'bin'), permissive).outcome).toBe('linked');
		expect(readFileSync(join(root, 'bin', 'npx.ps1'), 'utf8')).toContain('bootstrap.cjs');
		expect(
			unlinkOne(
				dirs,
				owner,
				readLinks(dirs).entries.find((item) => item.name === 'npx.ps1')!,
			),
		).toBe('restored');
		expect(readFileSync(join(root, 'bin', 'npx.ps1'), 'utf8')).toBe('x');
		writeFileSync(join(root, 'bin', 'npm.ps1'), 'someone put a file back');
		expect(linkState(entry)).toBe('changed');
		expect(unlinkOne(dirs, owner, entry)).toBe('changed');
		rmSync(join(root, 'bin', 'npm.ps1'));
		expect(unlinkOne(dirs, owner, entry)).toBe('restored');
		expect(readFileSync(join(root, 'bin', 'npm.ps1'), 'utf8')).toBe('original ps1');
	});

	it('reports a missing entry point', () => {
		const root = makeTree({ home: {}, bin: {} });
		const dirs = resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
		const [npm] = linkTargets(join(root, 'home'), 'linux', true);
		expect(linkOne(dirs, owner, join(root, 'bin'), npm!).outcome).toBe('missing');
	});
});
