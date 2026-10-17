import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertSafeHome,
	cmdShim,
	posixShim,
	powershellShim,
	renderShims,
	shimAbi,
} from '../../src/setup/shims.ts';
import { installHome } from '../helpers/launcher.ts';
import { makeTree, manifest, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

describe('shim contents', () => {
	it('renders sh shims everywhere and cmd plus ps1 on Windows', () => {
		const posix = renderShims('/home/me/.local/share/npm-vm', 'darwin');
		expect(posix.map((file) => file.name)).toEqual(['npm', 'npx', 'npm-vm']);
		expect(posix[0]?.content).toBe(
			'#!/bin/sh\n# npm-vm launcher abi=1\nexec node "/home/me/.local/share/npm-vm/bootstrap.cjs" npm "$@"\n',
		);
		expect(posixShim('/h', 'npm-vm')).toContain(' cli "$@"');
		expect(posixShim('/h', 'npx')).toContain(' npx "$@"');
		const windows = renderShims('C:\\Users\\me\\AppData\\Local\\npm-vm', 'win32');
		expect(windows.map((file) => file.name)).toEqual([
			'npm',
			'npm.cmd',
			'npm.ps1',
			'npx',
			'npx.cmd',
			'npx.ps1',
			'npm-vm',
			'npm-vm.cmd',
			'npm-vm.ps1',
		]);
		expect(
			renderShims('C:\\h', 'win32', { powershell: false }).map((file) => file.name),
		).not.toContain('npm.ps1');
	});

	it('the cmd shim resolves node.exe through PATH only and keeps a single command line', () => {
		const cmd = cmdShim('C:\\h', 'npm');
		const lines = cmd.split('\r\n').filter((line) => line !== '');
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain('for %%i in (node.exe) do');
		expect(lines[1]).toContain('"%%~$PATH:i" "C:\\h\\bootstrap.cjs" npm %*');
		expect(lines[1]).toContain('node.exe is not on PATH');
		expect(lines[1]).not.toMatch(/(^|\s)node(\s|$)/);
	});

	it('the PowerShell shim uses Get-Command and exits with the child code', () => {
		const ps1 = powershellShim('C:\\h', 'npx');
		expect(ps1).toContain('Get-Command node.exe -CommandType Application');
		expect(ps1).toContain("'C:\\h\\bootstrap.cjs' npx @args");
		expect(ps1).toContain('exit $LASTEXITCODE');
	});

	it('declares the ABI and refuses unsafe home paths', () => {
		expect(shimAbi(posixShim('/h', 'npm'))).toBe(1);
		expect(shimAbi(cmdShim('C:\\h', 'npm'))).toBe(1);
		expect(shimAbi('#!/bin/sh\nexec something')).toBeNull();
		for (const bad of [
			'/home/me "x"',
			"/home/o'brien",
			'/home/$USER',
			'/home/a%b',
			'/home/a!b',
			'/home/`x`',
			'/home/a\nb',
		]) {
			expect(() => assertSafeHome(bad), bad).toThrow(/NPM_VM_HOME/);
		}
		expect(() => assertSafeHome('/home/me with spaces/npm-vm')).not.toThrow();
	});
});

describe.skipIf(process.platform === 'win32')('sh shim end to end', () => {
	it('runs the launcher with the arguments intact', () => {
		const root = makeTree({ project: { 'package.json': manifest() } });
		const home = join(root, 'home with space');
		installHome(home);
		mkdirSync(join(home, 'shims'));
		for (const file of renderShims(home, process.platform)) {
			writeFileSync(join(home, 'shims', file.name), file.content);
			chmodSync(join(home, 'shims', file.name), file.mode);
		}
		const out = execFileSync(join(home, 'shims', 'npm'), ['--version', 'a b', 'c'], {
			cwd: join(root, 'project'),
			encoding: 'utf8',
			env: { ...process.env, NPM_VM_HOME: home },
		});
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
