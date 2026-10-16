import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		// The launcher tests run the built runtime from a temp home, so the build precedes every run.
		globalSetup: ['test/setup/build.ts'],
	},
});

export default config;
