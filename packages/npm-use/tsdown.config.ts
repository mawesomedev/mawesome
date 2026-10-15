import { defineConfig, type UserConfig } from 'tsdown';

/*
 * The library is dual ESM/CJS with per-format declarations.
 * Everything targets the runtime floor (spec section 2), not the repo's development Node.
 */
const config: UserConfig[] = defineConfig([
	{
		entry: ['src/index.ts'],
		format: ['esm', 'cjs'],
		dts: true,
		fixedExtension: false,
		platform: 'node',
		target: 'node22.9',
		sourcemap: true,
		clean: true,
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
	},
]);

export default config;
