import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findProject } from '../../src/project.ts';
import { prefixCorpus } from '../fixtures/prefix-corpus.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

/*
 * Spec RES-9: the computed root must equal `npm prefix` of real npm majors.
 * Each npm is fetched once through npx into a cache dir shared across runs; set NPM_VM_PARITY=0 to skip offline.
 */
const NPM_VERSIONS = ['8.19.4', '10.9.3', '11.6.0', '12.2.0'];
const enabled = process.env['NPM_VM_PARITY'] !== '0';
const cacheDir = join(tmpdir(), 'npm-vm-parity-cache');
const scratch = join(tmpdir(), 'npm-vm-parity-prefix');
const npmBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

afterAll(removeTrees);

function npmPrefix(version: string, cwd: string, argv: string[]): string {
	const out = execFileSync(npmBin, ['-y', '--prefix', scratch, `npm@${version}`, ...argv], {
		cwd,
		encoding: 'utf8',
		env: { ...cleanEnv(), npm_config_cache: cacheDir },
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
	});
	return out.trim();
}

/** The env a user's shell carries, without anything npm-specific that would steer the real npm. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^npm_/i.test(key)) {
			env[key] = value;
		}
	}
	return env;
}

describe.skipIf(!enabled)('npm prefix parity', () => {
	mkdirSync(scratch, { recursive: true });
	for (const version of NPM_VERSIONS) {
		it(`matches npm ${version}`, { timeout: 180_000 }, () => {
			const globalPrefix = npmPrefix(version, realpathSync(tmpdir()), ['prefix', '-g']);
			for (const entry of prefixCorpus) {
				if (entry.minNpm !== undefined && Number(version.split('.')[0]) < entry.minNpm) {
					continue;
				}
				const root = makeTree(entry.tree);
				for (const run of entry.runs) {
					const cwd = join(root, run.cwd);
					const ours = findProject(run.argv, cwd, {});
					const label = `${entry.name}: ${run.cwd} ${run.argv.join(' ')}`;
					const theirs = npmPrefix(version, cwd, prefixArgv(run.argv));
					if (ours.global) {
						expect(theirs, label).toBe(globalPrefix);
					} else {
						expect(realpathSync(theirs), label).toBe(ours.root);
					}
				}
			}
		});
	}
});

/** `npm prefix` plus the flags of the original call; the command word itself is dropped. */
function prefixArgv(argv: string[]): string[] {
	const dashDash = argv.indexOf('--');
	const flags = (dashDash === -1 ? argv : argv.slice(0, dashDash)).filter((arg, index, all) => {
		if (!arg.startsWith('-')) {
			return index > 0 && isValueFlag(all[index - 1] as string);
		}
		return true;
	});
	return ['prefix', ...flags];
}

function isValueFlag(flag: string): boolean {
	return ['--prefix', '-C', '--location', '-L', '--global', '--workspaces'].includes(flag);
}
