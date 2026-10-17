import { defineConfig } from 'oxfmt';

export default defineConfig({
	useTabs: true,
	printWidth: 100,
	singleQuote: true,
	semicolons: true,
	trailingComma: 'all',
	overrides: [
		{
			// The launcher is ES5 (runs on Node 10), where a trailing comma in a call is a syntax error.
			files: ['**/packages/npm-vm/src/bootstrap.cjs'],
			options: { trailingComma: 'none' },
		},
	],
});
