import { manifest, type Tree } from '../helpers/tree.ts';

/** One directory tree plus the (cwd, argv) pairs resolved inside it, shared by the unit and parity tests. */
export interface PrefixCase {
	name: string;
	tree: Tree;
	/** Relative cwd, relative argv paths, expected root relative to the tree root; `null` root means global mode. */
	runs: Array<{ cwd: string; argv: string[]; root: string | null }>;
	/** The first npm major whose workspace mapping agrees; older majors skip the case in the parity test. */
	minNpm?: number;
}

export const prefixCorpus: PrefixCase[] = [
	{
		name: 'plain project',
		tree: { 'package.json': manifest(), src: { deep: {} } },
		runs: [
			{ cwd: '.', argv: ['install'], root: '.' },
			{ cwd: 'src/deep', argv: ['run', 'build'], root: '.' },
			{ cwd: 'src', argv: ['--prefix', '.', 'ci'], root: 'src' },
			{ cwd: 'src', argv: ['--prefix=..', 'ci'], root: '.' },
			{ cwd: 'src', argv: ['-C', 'deep', 'ci'], root: 'src/deep' },
			{ cwd: '.', argv: ['i', '-g', 'x'], root: null },
			{ cwd: '.', argv: ['i', '--global', 'x'], root: null },
			{ cwd: '.', argv: ['i', '--global=true', 'x'], root: null },
			{ cwd: '.', argv: ['i', '--global', 'false', 'x'], root: '.' },
			{ cwd: '.', argv: ['i', '-g', '--no-global', 'x'], root: '.' },
			{ cwd: '.', argv: ['i', '--location=global', 'x'], root: null },
			{ cwd: '.', argv: ['i', '--location', 'project', 'x'], root: '.' },
			{ cwd: '.', argv: ['i', '-g', '--location=project', 'x'], root: null },
			{ cwd: '.', argv: ['i', '--no-global', '--location=global', 'x'], root: null },
			{ cwd: '.', argv: ['run', 'build', '--', '-g'], root: '.' },
		],
	},
	{
		name: 'node_modules without a manifest',
		tree: { node_modules: { '.keep': '' }, sub: {} },
		runs: [{ cwd: 'sub', argv: ['ls'], root: '.' }],
	},
	{
		name: 'a package.json directory is not a manifest',
		tree: {
			'package.json': manifest(),
			nested: { 'package.json': { 'not-a-file': '' }, deep: {} },
		},
		runs: [{ cwd: 'nested/deep', argv: ['ls'], root: '.' }],
	},
	{
		name: 'nothing above',
		tree: { empty: {} },
		runs: [{ cwd: 'empty', argv: ['ls'], root: 'empty' }],
	},
	{
		name: 'workspace root promotion',
		tree: {
			'package.json': manifest({ workspaces: ['packages/*', '!packages/skipped', 'tools/**'] }),
			packages: {
				a: { 'package.json': manifest({ name: 'a' }), lib: {} },
				skipped: { 'package.json': manifest({ name: 'skipped' }) },
				'no-manifest': { node_modules: {} },
			},
			tools: { nested: { deep: { 'package.json': manifest({ name: 'deep' }) } } },
			unrelated: { 'package.json': manifest({ name: 'unrelated' }) },
		},
		runs: [
			{ cwd: 'packages/a', argv: ['test'], root: '.' },
			{ cwd: 'packages/a/lib', argv: ['test'], root: '.' },
			{ cwd: 'packages/a', argv: ['test', '--no-workspaces'], root: 'packages/a' },
			{ cwd: 'packages/a', argv: ['test', '--workspaces=false'], root: 'packages/a' },
			{ cwd: 'packages/a', argv: ['test', '--workspaces', 'false'], root: 'packages/a' },
			{ cwd: 'packages/a', argv: ['test', '--ws'], root: '.' },
			{ cwd: 'packages/skipped', argv: ['test'], root: 'packages/skipped' },
			{ cwd: 'packages/no-manifest', argv: ['test'], root: 'packages/no-manifest' },
			{ cwd: 'tools/nested/deep', argv: ['test'], root: '.' },
			{ cwd: 'unrelated', argv: ['test'], root: 'unrelated' },
			{ cwd: 'packages/a', argv: ['--prefix', '.', 'test'], root: 'packages/a' },
			{ cwd: 'packages/a', argv: ['i', '-g', 'x'], root: null },
		],
	},
	{
		name: 'packages object form and re-added negation',
		// map-workspaces learned to drop a negation that a later pattern re-adds after npm 8.
		minNpm: 10,
		tree: {
			'package.json': manifest({
				workspaces: { packages: ['packages/**', '!packages/b/**', 'packages/b/a'] },
			}),
			packages: {
				b: {
					'package.json': manifest({ name: 'b' }),
					a: { 'package.json': manifest({ name: 'ba' }) },
					c: { 'package.json': manifest({ name: 'bc' }) },
				},
			},
		},
		runs: [
			{ cwd: 'packages/b/a', argv: ['test'], root: '.' },
			{ cwd: 'packages/b/c', argv: ['test'], root: '.' },
			{ cwd: 'packages/b', argv: ['test'], root: '.' },
		],
	},
	{
		name: 'negation that stays',
		tree: {
			'package.json': manifest({ workspaces: ['packages/*', '!packages/private'] }),
			packages: {
				pub: { 'package.json': manifest({ name: 'pub' }) },
				private: { 'package.json': manifest({ name: 'private' }) },
			},
		},
		runs: [
			{ cwd: 'packages/pub', argv: ['test'], root: '.' },
			{ cwd: 'packages/private', argv: ['test'], root: 'packages/private' },
		],
	},
	{
		name: 'grandparent workspace root',
		tree: {
			'package.json': manifest({ workspaces: ['apps/*/site'] }),
			apps: {
				web: {
					'package.json': manifest({ name: 'web' }),
					site: { 'package.json': manifest({ name: 'site' }) },
				},
			},
		},
		runs: [
			{ cwd: 'apps/web/site', argv: ['test'], root: '.' },
			{ cwd: 'apps/web', argv: ['test'], root: 'apps/web' },
		],
	},
];
