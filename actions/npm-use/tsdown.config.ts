/* The plugin is CJS with `module.exports = fn` but declares `export default`, so TypeScript nests the
 * callable one level deeper than Node does; the cast keeps the runtime shape. */
import * as licenseModule from 'rollup-plugin-license';
import { defineConfig, type UserConfig } from 'tsdown';

const license = licenseModule.default as unknown as typeof licenseModule.default.default;

/*
 * The action is one self-contained ESM file: every dependency is bundled, licenses are collected
 * next to it, and no declarations are emitted since nothing imports it. `dist` is committed
 * only in the mirror repository.
 */
const config: UserConfig = defineConfig({
	entry: { index: 'src/main.ts' },
	outDir: 'dist',
	format: ['esm'],
	platform: 'node',
	target: 'node24',
	fixedExtension: false,
	clean: true,
	sourcemap: true,
	dts: false,
	deps: { alwaysBundle: [/.*/] },
	plugins: [license({ thirdParty: { output: 'dist/licenses.txt' } })],
});

export default config;
