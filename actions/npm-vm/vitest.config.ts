import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});

export default config;
