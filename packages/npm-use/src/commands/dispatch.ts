import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXIT, isNpmUseError } from '../errors.ts';
import { resolveNpm, type ResolveResult } from '../index.ts';
import { isShell, profileBlock, SHELLS, type Shell } from '../setup/shell.ts';
import { cacheList, cachePrune, DEFAULT_PRUNE_DAYS, install, recover } from './cache.ts';
import { createCommandContext, type CommandContext, type CommandIo } from './context.ts';
import { doctor } from './doctor.ts';
import { pin } from './pin.ts';
import { selfUpdate } from './self-update.ts';
import { setup } from './setup.ts';
import { uninstall } from './uninstall.ts';

const VERSION = readSelfVersion();

const USAGE = `npm-use v${VERSION}: run the npm version a project declares in devEngines

Usage:
  npm-use <command> [options]

Commands:
  setup                  Install the launcher, shims and shell snippets; --link also replaces npm
                         inside every nvm/fnm Node. --shell <s> (repeatable), --yes, --dry-run,
                         --no-modify-profile, --cmd-autorun (Windows), --strict (exit 2 on skips).
  init <shell>           Print the snippet for zsh, bash, fish or powershell (--path, --hook; default both).
  doctor                 Check the installation; exit 1 when something needs fixing.
  which                  Print the npm that would run for the current directory.
  pin [<range>]          Write devEngines.packageManager for npm into the project's package.json.
  install [<spec>]       Download and verify the project's npm, or <spec>, into the cache.
  cache list             List cached npm versions.
  cache prune            Remove unused entries; --older-than <days> (default ${DEFAULT_PRUNE_DAYS}).
  self-update            Update npm-use with provenance verification; --rollback restores the previous version.
  recover                Finish a journal left by another machine: --journal <id> --confirm-dead-machine <id>.
  uninstall              Remove npm-use (--yes to skip the prompt, --purge-cache to drop the cache too).

Global options:
  --json                 Machine-readable output where a command offers it.
  --version, -v          Print the version.
  --help, -h             Print this help.

Environment:
  NPM_USE_VERSION        Use this range or version instead of the project's.
  NPM_USE_DISABLE        Any value: always run Node's own npm.
  NPM_USE_OFFLINE        Any value: never contact the registry.
  NPM_USE_HOME           The home directory (setup only).

Exit codes: 0 ok, 1 problems found, 2 partial setup under --strict, 3 resolution failed, 4 transport
unavailable, 5 verification failed, 6 launcher mismatch, 64 usage error.`;

export interface DispatchOptions {
	/** The home the launcher runs from; the bin entry leaves it to the env and defaults. */
	home?: string;
	io?: CommandIo;
	env?: NodeJS.ProcessEnv;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		allowNegative: true,
		options: {
			json: { type: 'boolean' },
			path: { type: 'boolean' },
			hook: { type: 'boolean' },
			link: { type: 'boolean' },
			shell: { type: 'string', multiple: true },
			yes: { type: 'boolean' },
			'dry-run': { type: 'boolean' },
			'modify-profile': { type: 'boolean' },
			'cmd-autorun': { type: 'boolean' },
			strict: { type: 'boolean' },
			'older-than': { type: 'string' },
			rollback: { type: 'boolean' },
			journal: { type: 'string' },
			'confirm-dead-machine': { type: 'string' },
			'purge-cache': { type: 'boolean' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
		},
	});
}

type Values = ReturnType<typeof parse>['values'];

/** Command-specific options, so a flag meant for another command is an error rather than silently ignored. */
const COMMAND_OPTIONS: Record<string, readonly (keyof Values)[]> = {
	setup: ['link', 'shell', 'yes', 'dry-run', 'modify-profile', 'cmd-autorun', 'strict'],
	init: ['path', 'hook'],
	doctor: [],
	which: [],
	pin: [],
	install: [],
	cache: ['older-than'],
	'self-update': ['rollback'],
	recover: ['journal', 'confirm-dead-machine'],
	uninstall: ['yes', 'purge-cache'],
};

function misplacedOptions(command: string, values: Values): string[] {
	const allowed = new Set<keyof Values>(COMMAND_OPTIONS[command] ?? []);
	return Object.values(COMMAND_OPTIONS)
		.flat()
		.filter((option) => !allowed.has(option) && values[option] !== undefined)
		.map((option) => `--${option}`);
}

export async function run(argv: string[], options: DispatchOptions): Promise<number> {
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
	if (COMMAND_OPTIONS[command] === undefined) {
		console.error(`Unknown command: ${command}`);
		console.error(USAGE);
		return EXIT.usage;
	}
	const misplaced = misplacedOptions(command, values);
	if (misplaced.length > 0) {
		console.error(`${misplaced.join(', ')} cannot be used with ${command}`);
		return EXIT.usage;
	}
	const context = createCommandContext({
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.io === undefined ? {} : { io: options.io }),
		json: values.json ?? false,
		version: VERSION,
	});
	try {
		return await dispatch(command, positionals.slice(1), values, context, options);
	} catch (error) {
		return reportError(error, context);
	}
}

async function dispatch(
	command: string,
	rest: string[],
	values: Values,
	context: CommandContext,
	options: DispatchOptions,
): Promise<number> {
	switch (command) {
		case 'setup': {
			const shells = values.shell ?? null;
			const bad = shells?.filter((shell) => !isShell(shell)) ?? [];
			if (bad.length > 0) {
				context.io.err(`--shell needs one of: ${SHELLS.join(', ')} (got ${bad.join(', ')})`);
				return EXIT.usage;
			}
			return setup(context, {
				link: values.link ?? false,
				shells: shells as Shell[] | null,
				yes: values.yes ?? false,
				dryRun: values['dry-run'] ?? false,
				modifyProfile: values['modify-profile'] ?? true,
				cmdAutorun: values['cmd-autorun'] ?? false,
				strict: values.strict ?? false,
			});
		}
		case 'init': {
			const shell = rest[0];
			if (shell === undefined || !isShell(shell)) {
				context.io.err(`init needs one of: ${SHELLS.join(', ')}`);
				return EXIT.usage;
			}
			const both = values.path !== true && values.hook !== true;
			process.stdout.write(
				profileBlock(shell, context.dirs.home, {
					path: both || values.path === true,
					hook: both || values.hook === true,
				}),
			);
			return EXIT.ok;
		}
		case 'doctor':
			return doctor(context);
		case 'which': {
			const result = await resolveNpm([], process.cwd(), {
				home: context.dirs.home,
				...(options.env === undefined ? {} : { env: options.env }),
			});
			context.io.out(context.json ? JSON.stringify(result, null, 2) : describeWhich(result));
			return EXIT.ok;
		}
		case 'pin':
			return pin(context, rest[0]);
		case 'install':
			return install(context, rest[0]);
		case 'cache': {
			if (rest[0] === 'list') {
				return cacheList(context);
			}
			if (rest[0] === 'prune') {
				return cachePrune(
					context,
					values['older-than'] === undefined ? DEFAULT_PRUNE_DAYS : Number(values['older-than']),
				);
			}
			context.io.err('cache needs list or prune');
			return EXIT.usage;
		}
		case 'self-update':
			return selfUpdate(context, { rollback: values.rollback ?? false });
		case 'recover': {
			if (values.journal === undefined || values['confirm-dead-machine'] === undefined) {
				context.io.err('recover needs --journal <id> and --confirm-dead-machine <machine-id>');
				return EXIT.usage;
			}
			return recover(context, values.journal, values['confirm-dead-machine']);
		}
		case 'uninstall':
			return uninstall(context, {
				yes: values.yes ?? false,
				purgeCache: values['purge-cache'] ?? false,
			});
		default:
			return EXIT.usage;
	}
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

function reportError(error: unknown, context: CommandContext): number {
	if (isNpmUseError(error)) {
		context.io.err(`npm-use: ${error.message}`);
		return error.exitCode;
	}
	context.io.err(
		`npm-use: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
	);
	return EXIT.problems;
}

declare const NPM_USE_BUILD_VERSION: string | undefined;

/** The build injects the package version; running from source reads the manifest instead. */
function readSelfVersion(): string {
	if (typeof NPM_USE_BUILD_VERSION === 'string') {
		return NPM_USE_BUILD_VERSION;
	}
	try {
		const manifest = JSON.parse(
			readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
		) as { version?: string };
		return manifest.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}
