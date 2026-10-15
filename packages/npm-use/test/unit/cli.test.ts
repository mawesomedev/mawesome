import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, manifest, removeTrees } from '../helpers/tree.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', 'src', 'cli.ts');

afterEach(removeTrees);

function run(args: string[], cwd = here, env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		cwd,
		env: { ...process.env, NPM_USE_VERSION: undefined, NPM_USE_DISABLE: undefined, ...env },
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('cli', () => {
	it('prints usage and exits 64 without a command', () => {
		const { status, stdout } = run([]);
		expect(status).toBe(64);
		expect(stdout).toContain('Usage:');
	});

	it('prints help and the version', () => {
		expect(run(['--help']).status).toBe(0);
		expect(run(['-v']).stdout).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('rejects an unknown command and an unknown flag', () => {
		expect(run(['frobnicate']).status).toBe(64);
		expect(run(['which', '--bogus']).status).toBe(64);
	});

	it("which reports Node's own npm when the project asks for nothing", () => {
		const root = makeTree({ 'package.json': manifest() });
		const { status, stdout } = run(['which', '--json'], root);
		expect(status).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ kind: 'own', source: null, projectRoot: root });
	});

	it('which fails with exit 3 when the requirement cannot be met offline', () => {
		const root = makeTree({
			'package.json': manifest({ devEngines: { packageManager: { name: 'npm', version: '^99' } } }),
		});
		const { status, stderr } = run(['which'], root, { NPM_USE_OFFLINE: '1' });
		expect(status).toBe(3);
		expect(stderr).toContain('^99');
	});

	it('which honours onFail warn and NPM_USE_DISABLE', () => {
		const root = makeTree({
			'package.json': manifest({
				devEngines: { packageManager: { name: 'npm', version: '^99', onFail: 'warn' } },
			}),
		});
		const warned = run(['which', '--json'], root, { NPM_USE_OFFLINE: '1' });
		expect(warned.status).toBe(0);
		expect(JSON.parse(warned.stdout)).toMatchObject({
			kind: 'own',
			warning: expect.stringContaining('^99'),
		});
		const disabled = run(['which', '--json'], root, { NPM_USE_DISABLE: '1' });
		expect(JSON.parse(disabled.stdout)).toMatchObject({ kind: 'own', warning: null, source: null });
	});
});
