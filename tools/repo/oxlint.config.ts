import { defineConfig } from 'oxlint';

export default defineConfig({
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		perf: 'warn',
	},
	plugins: ['import', 'typescript', 'unicorn', 'promise'],
	overrides: [
		{
			// pr-baseline talks to a rate-limited API; its sequential awaits are the pacing, not an oversight.
			files: ['**/packages/pr-baseline/**', '**/actions/pr-baseline/**'],
			rules: { 'no-await-in-loop': 'off' },
		},
		{
			// npm-use drives one transport npm and one registry; its awaits in loops are ordered on purpose.
			files: ['**/packages/npm-use/**', '**/actions/npm-use/**'],
			rules: { 'no-await-in-loop': 'off' },
		},
		{
			// The launcher is ES5 by design (runs on Node 10), where a catch clause must bind its error.
			files: ['**/packages/npm-use/src/bootstrap.cjs'],
			rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
		},
	],
});
