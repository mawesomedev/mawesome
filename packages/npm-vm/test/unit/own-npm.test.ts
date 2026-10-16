import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOwnNpm, ownNpmRoot } from '../../src/own-npm.ts';

const WIN = process.platform === 'win32';
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A Node install in this platform's layout: `bin/node` plus `lib/node_modules/npm`, or `node.exe` plus `node_modules/npm`. */
function fakePrefix(version: string): { node: string; npm: string } {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'npm-vm-own-')));
	dirs.push(prefix);
	const node = WIN ? join(prefix, 'node.exe') : join(prefix, 'bin', 'node');
	const npm = WIN
		? join(prefix, 'node_modules', 'npm')
		: join(prefix, 'lib', 'node_modules', 'npm');
	mkdirSync(dirname(node), { recursive: true });
	mkdirSync(join(npm, 'bin'), { recursive: true });
	writeFileSync(node, '');
	writeFileSync(join(npm, 'package.json'), JSON.stringify({ name: 'npm', version }));
	return { node, npm };
}

describe('ownNpmRoot', () => {
	it('uses the lib dir beside the real binary on POSIX and the exe dir on Windows', () => {
		expect(ownNpmRoot('/opt/node/bin/node', 'linux')).toBe('/opt/node/lib/node_modules/npm');
		expect(ownNpmRoot('C:\\nodejs\\node.exe', 'win32')).toBe('C:\\nodejs\\node_modules\\npm');
	});

	it.skipIf(WIN)('follows a symlinked node binary to its install', () => {
		const { node, npm } = fakePrefix('11.0.0');
		const linkDir = mkdtempSync(join(tmpdir(), 'npm-vm-link-'));
		dirs.push(linkDir);
		symlinkSync(node, join(linkDir, 'node'));
		expect(ownNpmRoot(join(linkDir, 'node'), process.platform)).toBe(npm);
	});
});

describe('findOwnNpm', () => {
	it('reads the version and bin paths', () => {
		const { node, npm } = fakePrefix('11.4.2');
		const own = findOwnNpm(node, process.platform);
		expect(own?.version).toBe('11.4.2');
		expect(own?.cliPath).toBe(join(npm, 'bin', 'npm-cli.js'));
		expect(own?.npxCliPath).toBe(join(npm, 'bin', 'npx-cli.js'));
	});

	it('finds the npm beside the running Node', () => {
		expect(findOwnNpm()?.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('returns null when there is no npm', () => {
		const empty = mkdtempSync(join(tmpdir(), 'npm-vm-none-'));
		dirs.push(empty);
		expect(findOwnNpm(join(empty, 'node'), process.platform)).toBeNull();
	});
});
