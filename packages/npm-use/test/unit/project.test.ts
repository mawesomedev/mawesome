import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProject, isGlobalMode, isWorkspaceOf, parsePrefixFlags } from '../../src/project.ts';
import { prefixCorpus } from '../fixtures/prefix-corpus.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

describe('parsePrefixFlags', () => {
	it('reads every form npm accepts and lets later flags win', () => {
		expect(parsePrefixFlags(['--prefix', 'a', '-C', 'b'], '/cwd').prefix).toBe(
			resolve('/cwd', 'b'),
		);
		expect(parsePrefixFlags(['--prefix=/abs'], '/cwd').prefix).toBe(resolve('/abs'));
		expect(parsePrefixFlags(['-g', '--no-global'], '/cwd').global).toBe(false);
		expect(parsePrefixFlags(['--global', 'false'], '/cwd').global).toBe(false);
		expect(parsePrefixFlags(['--global=false', '-g'], '/cwd').global).toBe(true);
		expect(parsePrefixFlags(['--location', 'global'], '/cwd').location).toBe('global');
		expect(parsePrefixFlags(['-L', 'user'], '/cwd').location).toBe('user');
		expect(parsePrefixFlags(['--', '--prefix', 'x'], '/cwd').prefix).toBeNull();
		expect(parsePrefixFlags(['--prefix'], '/cwd').prefix).toBeNull();
		expect(parsePrefixFlags(['--no-workspaces'], '/cwd').workspaces).toBe(false);
		expect(parsePrefixFlags(['--ws'], '/cwd').workspaces).toBe(true);
	});
});

describe('isGlobalMode', () => {
	it('prefers the command line over the env', () => {
		const flags = parsePrefixFlags([], '/cwd');
		expect(isGlobalMode(flags, {})).toBe(false);
		expect(isGlobalMode(flags, { npm_config_global: 'true' })).toBe(true);
		expect(isGlobalMode(flags, { npm_config_location: 'global' })).toBe(true);
		expect(
			isGlobalMode(parsePrefixFlags(['--no-global'], '/cwd'), { npm_config_global: 'true' }),
		).toBe(false);
		expect(
			isGlobalMode(parsePrefixFlags(['--location=project'], '/cwd'), { npm_config_global: 'true' }),
		).toBe(false);
	});
});

describe('isWorkspaceOf', () => {
	it('ignores node_modules and requires a manifest', () => {
		const root = makeTree({
			node_modules: { dep: { 'package.json': '{}' } },
			packages: { a: { 'package.json': '{}' }, b: {} },
		});
		expect(isWorkspaceOf(root, join(root, 'node_modules', 'dep'), ['**'])).toBe(false);
		expect(isWorkspaceOf(root, join(root, 'packages', 'a'), ['packages/*'])).toBe(true);
		expect(isWorkspaceOf(root, join(root, 'packages', 'b'), ['packages/*'])).toBe(false);
		expect(isWorkspaceOf(root, root, ['**'])).toBe(false);
		expect(isWorkspaceOf(root, join(root, 'packages', 'a'), ['./packages/a/'])).toBe(true);
	});
});

describe('findProject corpus', () => {
	for (const entry of prefixCorpus) {
		it(entry.name, () => {
			const root = makeTree(entry.tree);
			for (const run of entry.runs) {
				const cwd = join(root, run.cwd);
				const project = findProject(run.argv, cwd, {});
				const label = `${run.cwd} ${run.argv.join(' ')}`;
				if (run.root === null) {
					expect(project.global, label).toBe(true);
				} else {
					expect(project.global, label).toBe(false);
					expect(project.root, label).toBe(resolve(root, run.root));
				}
			}
		});
	}
});
