#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXIT, isNpmUseError } from './errors.ts';
import { resolveNpm, type ResolveResult } from './index.ts';

const VERSION = readSelfVersion();

const USAGE = `npm-use v${VERSION}: run the npm version a project declares in devEngines

Usage:
  npm-use <command> [options]

Commands:
  which                  Print the npm that would run for the current directory.

Global options:
  --json                 Machine-readable output where a command offers it.
  --version, -v          Print the version.
  --help, -h             Print this help.

Environment:
  NPM_USE_VERSION        Use this range or version instead of the project's.
  NPM_USE_DISABLE        Any value: always run Node's own npm.
  NPM_USE_OFFLINE        Any value: never contact the registry.

Exit codes: 0 ok, 1 problems found, 3 resolution failed, 4 transport unavailable, 5 verification failed, 64 usage error.`;

export async function main(argv: string[]): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		console.error((error as Error).message);
		console.error(USAGE);
		return EXIT.usage;
	}
	const { values, positionals } = parsed;
	if (values.version) {
		console.log(VERSION);
		return EXIT.ok;
	}
	const command = positionals[0];
	if (values.help || command === undefined) {
		console.log(USAGE);
		return command === undefined && !values.help ? EXIT.usage : EXIT.ok;
	}
	try {
		switch (command) {
			case 'which': {
				const result = await resolveNpm([], process.cwd());
				emit(values.json ?? false, result, describeWhich(result));
				return EXIT.ok;
			}
			default:
				console.error(`Unknown command: ${command}`);
				console.error(USAGE);
				return EXIT.usage;
		}
	} catch (error) {
		return reportError(error);
	}
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: 'boolean' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
		},
	});
}

function describeWhich(result: ResolveResult): string {
	const where =
		result.kind === 'own' ? "Node's own npm" : result.kind === 'cached' ? 'cached' : 'to download';
	const from =
		result.source === null
			? 'no project requirement'
			: `${result.source.field} in ${result.source.file}`;
	const lines = [`npm ${result.version} (${where}): ${result.cliPath}`, `Source: ${from}`];
	if (result.warning !== null) {
		lines.push(`Warning: ${result.warning}`);
	}
	return lines.join('\n');
}

function emit(json: boolean, result: unknown, text: string): void {
	console.log(json ? JSON.stringify(result, null, 2) : text);
}

function reportError(error: unknown): number {
	if (isNpmUseError(error)) {
		console.error(`npm-use: ${error.message}`);
		return error.exitCode;
	}
	console.error(
		`npm-use: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
	);
	return EXIT.problems;
}

function readSelfVersion(): string {
	try {
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as {
			version?: string;
		};
		return manifest.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	process.exitCode = reportError(error);
}
