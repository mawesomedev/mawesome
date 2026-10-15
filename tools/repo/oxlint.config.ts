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
			files: ['**/packages/npm-use/**'],
			rules: { 'no-await-in-loop': 'off' },
		},
	],
});
