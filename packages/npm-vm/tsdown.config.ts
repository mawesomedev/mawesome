import { readFileSync } from 'node:fs';
import { defineConfig, type UserConfig } from 'tsdown';

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
	version: string;
};
const define = { NPM_VM_BUILD_VERSION: JSON.stringify(version) };

/*
 * Three outputs (spec section 3.1): the dual ESM/CJS library, the ESM bin, and the CJS runtime bundle
 * that the launcher loads from the home, with its lazy chunks and the hand-written bootstrap beside it.
 * Everything targets the runtime floor, not the repo's development Node.
 */
const config: UserConfig[] = defineConfig([
	{
		entry: ['src/index.ts', 'src/internal.ts'],
		format: ['esm', 'cjs'],
		dts: true,
		fixedExtension: false,
		platform: 'node',
		target: 'node22.9',
		sourcemap: true,
		clean: true,
		define,
	},
	{
		entry: ['src/cli.ts'],
		format: ['esm'],
		dts: false,
		fixedExtension: false,
		platform: 'node',
		target: 'node22.9',
		sourcemap: true,
		clean: false,
		define,
	},
	{
		entry: ['src/runtime.ts'],
		outDir: 'dist/runtime',
		format: ['cjs'],
		dts: false,
		fixedExtension: true,
		platform: 'node',
		target: 'node22.9',
		sourcemap: false,
		clean: false,
		noExternal: /./,
		shims: true,
		define,
		copy: [
			{ from: 'src/bootstrap.cjs', to: 'dist/runtime' },
			{ from: 'src/launchers/*.tmpl', to: 'dist/runtime/launchers' },
		],
	},
]);

export default config;
