import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, NpmUseError } from './errors.ts';
import { engineMessage, noMatchMessage } from './messages.ts';
import type { OwnNpm } from './own-npm.ts';
import { createContext, createInstaller } from './install/index.ts';
import { findProject } from './project.ts';
import { selectCandidate, ownNpmSatisfies, type Candidate, type Selection } from './select.ts';
import {
	parseSpecs,
	parseVersionSpec,
	SpecError,
	type NpmSpec,
	type OnFail,
	type ParsedSpecs,
} from './spec.ts';

export type { NpmSpec, OnFail, ParsedSpecs } from './spec.ts';
export type { Candidate, Selection } from './select.ts';
export { EXIT, NpmUseError } from './errors.ts';

export interface ResolveSource {
	file: string;
	field: 'devEngines' | 'packageManager' | 'env';
}

export interface ResolveResult {
	kind: 'own' | 'cached' | 'download';
	version: string;
	/** Absolute path to `bin/npm-cli.js`; for a download, the path the entry will have once fetched. */
	cliPath: string;
	source: ResolveSource | null;
	projectRoot: string | null;
	/** Set for `cached` and `download`: what to fetch or verify. */
	selection: Selection | null;
	/** A warning to print on stderr before running Node's own npm (`onFail: warn`). */
	warning: string | null;
}

export interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	offline?: boolean;
}

/** The lookups resolution depends on; the install layer provides the real ones. */
export interface ResolveProviders {
	ownNpm(): OwnNpm | null;
	cached(specs: readonly NpmSpec[]): Promise<Candidate[]>;
	registry(specs: readonly NpmSpec[]): Promise<Candidate[]>;
	nodeVersion: string;
	/** Path a download will occupy, so callers can report it before fetching. */
	entryPathFor(candidate: Candidate): string;
}

/** Resolves the npm to run for `argv` in `cwd` (spec section 5); writes only under the cache, spawns npm only as the transport. */
export function resolveNpm(
	argv: readonly string[],
	cwd: string,
	options: ResolveOptions = {},
): Promise<ResolveResult> {
	const env = options.env ?? process.env;
	return resolveNpmWith(argv, cwd, options, createInstaller(createContext(env)));
}

export async function resolveNpmWith(
	argv: readonly string[],
	cwd: string,
	options: ResolveOptions,
	providers: ResolveProviders,
): Promise<ResolveResult> {
	const env = options.env ?? process.env;
	const own = providers.ownNpm();
	const ownResult = (
		projectRoot: string | null,
		source: ResolveSource | null,
		warning: string | null,
	): ResolveResult => {
		if (own === null) {
			throw new NpmUseError(
				'M-TRANSPORT',
				EXIT.transport,
				'No npm found beside the active Node; reinstall Node.',
			);
		}
		return {
			kind: 'own',
			version: own.version,
			cliPath: own.cliPath,
			source,
			projectRoot,
			selection: null,
			warning,
		};
	};

	if (nonEmpty(env['NPM_USE_DISABLE'])) {
		return ownResult(null, null, null);
	}
	const project = findProject(argv, cwd, env);
	if (project.global) {
		return ownResult(project.root, null, null);
	}

	let parsed: ParsedSpecs;
	let source: ResolveSource;
	if (nonEmpty(env['NPM_USE_VERSION'])) {
		parsed = {
			specs: [parseVersionSpec(env['NPM_USE_VERSION'] as string, 'NPM_USE_VERSION')],
			onFail: 'error',
			field: 'devEngines',
		};
		source = { file: 'NPM_USE_VERSION', field: 'env' };
	} else {
		const file = join(project.root, 'package.json');
		const read = readSpecs(file);
		if (read === null) {
			return ownResult(project.root, null, null);
		}
		parsed = read;
		source = { file, field: read.field };
	}

	if (own !== null && ownNpmSatisfies(own.version, parsed.specs)) {
		return ownResult(project.root, source, null);
	}

	const cached = await providers.cached(parsed.specs);
	let result = selectCandidate(parsed.specs, cached, providers.nodeVersion);
	if (result.kind === 'failed' && !options.offline && !nonEmpty(env['NPM_USE_OFFLINE'])) {
		let fromRegistry: Candidate[];
		try {
			fromRegistry = await providers.registry(parsed.specs);
		} catch (error) {
			// A download that cannot happen follows the project's policy like a missing version does.
			if (!(error instanceof NpmUseError) || error.id !== 'M-TRANSPORT') {
				throw error;
			}
			return applyPolicy(parsed.onFail, error, () =>
				ownResult(project.root, source, error.message),
			);
		}
		result = selectCandidate(parsed.specs, fromRegistry, providers.nodeVersion);
	}
	if (result.kind === 'selected') {
		const { candidate } = result.selection;
		const entry = candidate.entryPath ?? providers.entryPathFor(candidate);
		return {
			kind: candidate.entryPath === null ? 'download' : 'cached',
			version: candidate.version,
			cliPath: join(entry, 'bin', 'npm-cli.js'),
			source,
			projectRoot: project.root,
			selection: result.selection,
			warning: null,
		};
	}

	const message =
		result.failure.kind === 'engine'
			? engineMessage(result.failure.version, result.failure.enginesNode, providers.nodeVersion)
			: noMatchMessage(parsed.specs, source.file, result.failure.reason);
	const id = result.failure.kind === 'engine' ? 'M-ENGINE' : 'M-NOMATCH';
	const failure = new NpmUseError(id, EXIT.resolution, message);
	return applyPolicy(parsed.onFail, failure, () => ownResult(project.root, source, message));
}

/** `onFail` makes a failed resolution fatal, a warning before Node's own npm, or silent (spec RES-7). */
function applyPolicy(
	onFail: OnFail,
	failure: NpmUseError,
	fallback: () => ResolveResult,
): ResolveResult {
	if (onFail === 'ignore') {
		return { ...fallback(), warning: null };
	}
	if (onFail === 'warn') {
		return fallback();
	}
	throw failure;
}

/** Reads and validates the project's specs; a broken file or range follows its own `onFail` when readable, else errors. */
function readSpecs(file: string): ParsedSpecs | null {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return null;
	}
	let pkg: unknown;
	try {
		pkg = JSON.parse(text);
	} catch (error) {
		throw new NpmUseError(
			'M-NOMATCH',
			EXIT.resolution,
			`${file} is not valid JSON: ${(error as Error).message}`,
		);
	}
	try {
		return parseSpecs(pkg);
	} catch (error) {
		if (error instanceof SpecError) {
			throw new NpmUseError('M-NOMATCH', EXIT.resolution, `${file}: ${error.message}`);
		}
		throw error;
	}
}

function nonEmpty(value: string | undefined): boolean {
	return value !== undefined && value !== '';
}
