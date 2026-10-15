import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';

export interface ProjectLocation {
	/** npm's `localPrefix` for this argv and cwd (spec RES-2). */
	root: string;
	/** Global mode, computed as npm does (spec RES-3). */
	global: boolean;
	/** The `--prefix` the command line carries, resolved, when it carries one. */
	cliPrefix: string | null;
}

interface CliFlags {
	prefix: string | null;
	global: boolean | null;
	location: string | null;
	workspaces: boolean | null;
}

const BOOLEANS = new Set(['global', 'workspaces']);
const SHORTHANDS: Record<string, string> = {
	C: 'prefix',
	g: 'global',
	L: 'location',
	ws: 'workspaces',
};

/**
 * The subset of nopt that decides the prefix: `--flag value`, `--flag=value`, `--no-flag`, `--flag true|false` for booleans, npm's shorthands and `--`.
 * Later flags win, as in nopt.
 */
export function parsePrefixFlags(argv: readonly string[], cwd: string): CliFlags {
	const flags: CliFlags = { prefix: null, global: null, location: null, workspaces: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === '--') {
			break;
		}
		let name: string;
		let value: string | null = null;
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			value = eq === -1 ? null : arg.slice(eq + 1);
			name = SHORTHANDS[name] ?? name;
		} else if (arg.startsWith('-') && arg.length > 1 && SHORTHANDS[arg.slice(1)] !== undefined) {
			name = SHORTHANDS[arg.slice(1)] as string;
		} else {
			continue;
		}
		let negated = false;
		if (name.startsWith('no-') && BOOLEANS.has(name.slice(3))) {
			negated = true;
			name = name.slice(3);
		}
		if (BOOLEANS.has(name)) {
			let bool = !negated;
			if (value !== null) {
				bool = value !== 'false';
			} else if (!negated && (argv[i + 1] === 'true' || argv[i + 1] === 'false')) {
				bool = argv[i + 1] === 'true';
				i += 1;
			}
			if (name === 'global') {
				flags.global = bool;
			} else {
				flags.workspaces = bool;
			}
			continue;
		}
		if (name !== 'prefix' && name !== 'location') {
			continue;
		}
		if (value === null) {
			if (i + 1 >= argv.length) {
				continue;
			}
			value = argv[i + 1] as string;
			i += 1;
		}
		if (name === 'prefix') {
			flags.prefix = resolve(cwd, value);
		} else {
			flags.location = value;
		}
	}
	return flags;
}

/** Global mode from the command line and the npm env, CLI winning (spec RES-3). */
export function isGlobalMode(flags: CliFlags, env: NodeJS.ProcessEnv): boolean {
	// npm: `global || location === 'global'`, each setting resolved on its own, CLI over env.
	const fromEnv = env['npm_config_global'];
	// npm ignores an empty value; nopt reads any other value as true except its spellings of false.
	const global =
		flags.global ??
		(fromEnv === undefined || fromEnv === '' ? null : !['false', '0', 'null'].includes(fromEnv));
	const location = flags.location ?? env['npm_config_location'] ?? null;
	return global === true || location === 'global';
}

function hasPackageJson(dir: string): boolean {
	try {
		return statSync(join(dir, 'package.json')).isFile();
	} catch {
		return false;
	}
}

function hasNodeModules(dir: string): boolean {
	try {
		return statSync(join(dir, 'node_modules')).isDirectory();
	} catch {
		return false;
	}
}

function* walkUp(start: string): Generator<string> {
	let dir = resolve(start);
	for (;;) {
		yield dir;
		const parent = dirname(dir);
		if (parent === dir) {
			return;
		}
		dir = parent;
	}
}

/** The `workspaces` patterns of a manifest: the array form or `{ packages: [] }`, else none. */
export function workspacePatterns(pkg: unknown): string[] {
	if (typeof pkg !== 'object' || pkg === null) {
		return [];
	}
	let raw = (pkg as { workspaces?: unknown }).workspaces;
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
		raw = (raw as { packages?: unknown }).packages;
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Whether `candidate` is one of the workspaces `root` declares, matched like `@npmcli/map-workspaces`.
 * A pattern selects directories holding a `package.json`, `!pattern` removes matches, and `node_modules` never matches.
 */
export function isWorkspaceOf(
	root: string,
	candidate: string,
	patterns: readonly string[],
): boolean {
	const rel = relative(root, candidate);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !hasPackageJson(candidate)) {
		return false;
	}
	if (rel.split(sep).includes('node_modules')) {
		return false;
	}
	const posix = rel.split(sep).join('/');
	const { positive, negative } = splitPatterns(patterns);
	return (
		positive.some((pattern) => matchesGlob(posix, pattern)) &&
		!negative.some((pattern) => matchesGlob(posix, pattern))
	);
}

/*
 * map-workspaces drops a negated pattern when a later positive pattern falls under it,
 * so `['packages/**', '!packages/b/**', 'packages/b/a']` keeps `packages/b/a`.
 */
function splitPatterns(patterns: readonly string[]): { positive: string[]; negative: string[] } {
	const positive: string[] = [];
	const negative: string[] = [];
	for (const raw of patterns) {
		const bangs = /^!+/.exec(raw)?.[0].length ?? 0;
		const pattern = normalizePattern(raw.slice(bangs));
		if (bangs % 2 === 1) {
			negative.push(pattern);
			continue;
		}
		for (let i = negative.length - 1; i >= 0; i -= 1) {
			if (matchesGlob(pattern, negative[i] as string)) {
				negative.splice(i, 1);
			}
		}
		positive.push(pattern);
	}
	return { positive, negative };
}

function normalizePattern(pattern: string): string {
	return pattern
		.replace(/\\/g, '/')
		.replace(/^\.?\/+/, '')
		.replace(/\/+$/, '');
}

function readManifest(dir: string): unknown {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
	} catch {
		return null;
	}
}

/**
 * Mirrors `@npmcli/config` `loadLocalPrefix` (spec RES-2): a CLI prefix is final.
 * Otherwise the nearest ancestor with `package.json` or `node_modules` wins, promoted to a parent whose `workspaces` include it unless `--no-workspaces` or global mode.
 */
export function findProject(
	argv: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ProjectLocation {
	const flags = parsePrefixFlags(argv, cwd);
	const global = isGlobalMode(flags, env);
	if (flags.prefix !== null) {
		return { root: flags.prefix, global, cliPrefix: flags.prefix };
	}
	let localPrefix: string | null = null;
	for (const dir of walkUp(cwd)) {
		const manifest = hasPackageJson(dir);
		if (localPrefix === null) {
			if (manifest || hasNodeModules(dir)) {
				localPrefix = dir;
				if (flags.workspaces === false || global) {
					break;
				}
			}
			continue;
		}
		if (!manifest) {
			continue;
		}
		const pkg = readManifest(dir);
		if (pkg !== null && isWorkspaceOf(dir, localPrefix, workspacePatterns(pkg))) {
			localPrefix = dir;
			break;
		}
	}
	return { root: localPrefix ?? resolve(cwd), global, cliPrefix: null };
}
