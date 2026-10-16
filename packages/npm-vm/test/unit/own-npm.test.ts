import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOwnNpm, ownNpmRoot } from '../../src/own-npm.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakePrefix(version: string): string {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'npm-vm-own-')));
	dirs.push(prefix);
	mkdirSync(join(prefix, 'bin'));
	mkdirSync(join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
	writeFileSync(join(prefix, 'bin', 'node'), '');
	writeFileSync(
		join(prefix, 'lib', 'node_modules', 'npm', 'package.json'),
		JSON.stringify({ name: 'npm', version }),
	);
	return prefix;
}

describe('ownNpmRoot', () => {
	it('uses the lib dir beside the real binary on POSIX and the exe dir on Windows', () => {
		expect(ownNpmRoot('/opt/node/bin/node', 'linux')).toBe('/opt/node/lib/node_modules/npm');
		expect(ownNpmRoot('C:\\nodejs\\node.exe', 'win32')).toBe('C:\\nodejs\\node_modules\\npm');
	});

	it('follows a symlinked node binary to its install', () => {
		const prefix = fakePrefix('11.0.0');
		const linkDir = mkdtempSync(join(tmpdir(), 'npm-vm-link-'));
		dirs.push(linkDir);
		symlinkSync(join(prefix, 'bin', 'node'), join(linkDir, 'node'));
		expect(ownNpmRoot(join(linkDir, 'node'), 'linux')).toBe(
			join(prefix, 'lib', 'node_modules', 'npm'),
		);
	});
});

describe('findOwnNpm', () => {
	it('reads the version and bin paths', () => {
		const prefix = fakePrefix('11.4.2');
		const own = findOwnNpm(join(prefix, 'bin', 'node'), 'linux');
		expect(own?.version).toBe('11.4.2');
		expect(own?.cliPath).toBe(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
		expect(own?.npxCliPath).toBe(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
	});

	it('finds the npm beside the running Node', () => {
		expect(findOwnNpm()?.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('returns null when there is no npm', () => {
		const empty = mkdtempSync(join(tmpdir(), 'npm-vm-none-'));
		dirs.push(empty);
		expect(findOwnNpm(join(empty, 'node'), 'linux')).toBeNull();
	});
});
