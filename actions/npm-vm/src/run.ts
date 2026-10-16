import * as core from '@actions/core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	createContext,
	createInstaller,
	findProject,
	isNpmVmError,
	parseSpecs,
	parseVersionSpec,
	resolveNpmWith,
	runCommand,
	selectCandidate,
	sriHex,
	type Candidate,
	type NpmSpec,
	type ResolveResult,
} from '@mawesome/npm-vm';
import type { PackedSource } from '@mawesome/npm-vm';

/** Bumped whenever the cached artifact's layout changes, so an old cache never restores (spec ACT-3). */
const SCHEMA = 1;

/** What the cache holds beside the tarball: enough to re-verify it without the registry (spec ACT-2). */
interface ArtifactIndex {
	schema: number;
	version: string;
	integrity: string;
	tarball: string;
	signatures: Array<{ keyid: string; sig: string }>;
	publishedAt: string | null;
	registry: string;
	enginesNode: string | null;
}

export interface CacheStore {
	restore(paths: string[], primaryKey: string, restoreKeys: string[]): Promise<string | undefined>;
	save(paths: string[], key: string): Promise<void>;
}

export interface RunDeps {
	cache?: CacheStore;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

const actionsCache: CacheStore = {
	async restore(paths, primaryKey, restoreKeys) {
		const cache = await import('@actions/cache');
		return cache.restoreCache(paths, primaryKey, restoreKeys);
	},
	async save(paths, key) {
		const cache = await import('@actions/cache');
		try {
			await cache.saveCache(paths, key);
		} catch (error) {
			// A parallel job saving the same key is not a failure of this one.
			if (!(error instanceof cache.ReserveCacheError)) {
				throw error;
			}
		}
	},
};

function hashOf(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function emit(values: Record<string, string>): void {
	for (const [name, value] of Object.entries(values)) {
		core.setOutput(name, value);
	}
}

export async function run(deps: RunDeps = {}): Promise<void> {
	try {
		await main(deps);
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function main(deps: RunDeps): Promise<void> {
	const env = deps.env ?? process.env;
	const runnerTemp = env['RUNNER_TEMP'];
	if (runnerTemp === undefined || runnerTemp === '') {
		throw new Error('RUNNER_TEMP is not set; this action runs on a GitHub Actions runner.');
	}
	const workdir = resolve(deps.cwd ?? process.cwd(), core.getInput('working-directory') || '.');
	const requested = core.getInput('version');
	const useCache = core.getBooleanInput('cache');
	const home = join(runnerTemp, 'npm-vm', 'home');
	const actionEnv: NodeJS.ProcessEnv = {
		...env,
		NPM_VM_HOME: home,
		...(requested === '' ? {} : { NPM_VM_VERSION: requested }),
	};

	// Install the launcher and shims under RUNNER_TEMP and put them on PATH for the following steps (spec ACT-4).
	// No profile is edited and no shell is probed: GITHUB_PATH is the only PATH that matters here.
	const setup = await runCommand(['setup', '--yes', '--no-modify-profile', '--no-user-path'], {
		home,
		env: actionEnv,
		io: quietIo(),
	});
	if (setup !== 0 || !existsSync(join(home, 'shims'))) {
		throw new Error(`npm-vm setup exited with ${setup}`);
	}
	core.addPath(join(home, 'shims'));

	// Resolve once; every later step runs this exact version through the shims (spec ACT-1).
	// Later steps run `node` from PATH (setup-node's), which may not be the runtime this action runs on.
	const node = pathNode(actionEnv);
	const installer = createInstaller(createContext(actionEnv, home, node));
	const artifactDir = join(runnerTemp, 'npm-vm', 'artifact');
	const store = deps.cache ?? actionsCache;
	let result: ResolveResult;
	try {
		result = await resolveNpmWith([], workdir, { env: actionEnv }, installer);
	} catch (error) {
		// Offline or unreachable registry: a restored tarball may still satisfy the project (spec ACT-3).
		const specs =
			useCache && isNpmVmError(error) && (error.exitCode === 3 || error.exitCode === 4)
				? projectSpecs(workdir, actionEnv)
				: null;
		if (specs === null) {
			throw error;
		}
		const restored = await restoreFromCache(
			store,
			artifactDir,
			await keyPrefix(installer, specs, env),
			specs,
			null,
			installer,
		);
		if (restored === null) {
			throw error;
		}
		pinForLaterSteps(restored.version);
		emit({
			version: restored.version,
			kind: 'download',
			'cli-path': join(restored.entryPath, 'bin', 'npm-cli.js'),
			'cache-hit': 'true',
		});
		core.info(
			`npm ${restored.version} (from the Actions cache, registry unreachable): ${restored.entryPath}`,
		);
		restored.lease.release();
		return;
	}
	if (result.selection === null || result.specs === null) {
		report(result, result.cliPath, false);
		return;
	}
	const keyBase = useCache ? await keyPrefix(installer, result.specs, env) : null;
	if (keyBase !== null) {
		const restored = await restoreFromCache(
			store,
			artifactDir,
			keyBase,
			result.specs,
			result.selection.candidate,
			installer,
		);
		if (restored !== null) {
			report(
				{ ...result, version: restored.version },
				join(restored.entryPath, 'bin', 'npm-cli.js'),
				true,
			);
			restored.lease.release();
			return;
		}
	}
	if (result.kind === 'cached') {
		const ensured = await installer.ensure(result.selection);
		ensured.lease.release();
		report(result, join(ensured.entryPath, 'bin', 'npm-cli.js'), false);
		return;
	}
	let saved: { key: string } | null = null;
	const ensured = await installer.ensure(result.selection, {
		async onPacked(source, digests) {
			if (keyBase === null) {
				return;
			}
			rmSync(artifactDir, { recursive: true, force: true });
			mkdirSync(artifactDir, { recursive: true });
			const tarball = `npm-${source.published.version}.tgz`;
			copyFileSync(source.file, join(artifactDir, tarball));
			const index: ArtifactIndex = {
				schema: SCHEMA,
				version: source.published.version,
				integrity: source.published.integrity,
				tarball,
				signatures: source.published.signatures,
				publishedAt: await source.publishedAt(),
				registry: source.registry,
				enginesNode: source.published.enginesNode,
			};
			writeFileSync(join(artifactDir, 'index.json'), JSON.stringify(index));
			saved = { key: `${keyBase}${source.published.version}-${digests.sha512hex.slice(0, 16)}` };
		},
	});
	ensured.lease.release();
	if (saved !== null) {
		await store.save([artifactDir], (saved as { key: string }).key);
	}
	report(result, join(ensured.entryPath, 'bin', 'npm-cli.js'), false);
}

/** Later steps resolve through the shims again; the exact version stays pinned whatever directory they run in (spec ACT-1). */
function pinForLaterSteps(version: string): void {
	core.exportVariable('NPM_VM_VERSION', version);
}

/** The `node` the shims will resolve through PATH, asked for its own path and version. */
function pathNode(env: NodeJS.ProcessEnv): { execPath: string; version: string } {
	try {
		const out = execFileSync(
			process.platform === 'win32' ? 'node.exe' : 'node',
			['-p', 'JSON.stringify([process.execPath, process.version])'],
			{
				encoding: 'utf8',
				env,
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			},
		);
		const [execPath, version] = JSON.parse(out) as [string, string];
		return { execPath, version };
	} catch {
		return { execPath: process.execPath, version: process.version };
	}
}

/** The project's npm requirements, read the way the launcher reads them; null when it declares nothing. */
function projectSpecs(workdir: string, env: NodeJS.ProcessEnv): NpmSpec[] | null {
	const override = env['NPM_VM_VERSION'];
	if (override !== undefined && override !== '') {
		return [parseVersionSpec(override, 'NPM_VM_VERSION')];
	}
	const project = findProject([], workdir, env);
	try {
		return (
			parseSpecs(JSON.parse(readFileSync(join(project.root, 'package.json'), 'utf8')))?.specs ??
			null
		);
	} catch {
		return null;
	}
}

/** `npm-vm-v<schema>-<os>-node<version>-<registry>-<constraint>-`; the full key appends version and integrity (spec ACT-3). */
async function keyPrefix(
	installer: ReturnType<typeof createInstaller>,
	specs: readonly NpmSpec[],
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const constraint = hashOf(JSON.stringify(specs));
	const registry = await installer.registryIdentity();
	return `npm-vm-v${SCHEMA}-${env['RUNNER_OS'] ?? process.platform}-node${installer.nodeVersion}-${registry}-${constraint}-`;
}

function readIndex(dir: string): ArtifactIndex | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as ArtifactIndex;
		return parsed.schema === SCHEMA &&
			typeof parsed.version === 'string' &&
			typeof parsed.integrity === 'string'
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * A restored tarball is used only when it still satisfies the project and this Node, and only after the
 * same verification a download gets (spec ACT-2, ACT-3). Anything else falls through to a download.
 */
async function restoreFromCache(
	cache: CacheStore,
	artifactDir: string,
	keyBase: string,
	specs: readonly NpmSpec[],
	resolved: Candidate | null,
	installer: ReturnType<typeof createInstaller>,
): Promise<{ entryPath: string; version: string; lease: { release(): void } } | null> {
	// The saved key ends in the tarball's sha512 prefix, which equals the SRI digest once verified.
	const primary =
		resolved === null
			? keyBase
			: `${keyBase}${resolved.version}-${(sriHex(resolved.integrity) ?? '').slice(0, 16)}`;
	rmSync(artifactDir, { recursive: true, force: true });
	const hit = await cache.restore([artifactDir], primary, [keyBase]);
	if (hit === undefined) {
		return null;
	}
	const index = readIndex(artifactDir);
	if (index === null || !existsSync(join(artifactDir, index.tarball))) {
		core.info('The restored cache is unusable; downloading instead.');
		return null;
	}
	const candidate: Candidate = {
		version: index.version,
		enginesNode: index.enginesNode,
		integrity: index.integrity,
		entryPath: null,
		signatures: index.signatures,
	};
	if (
		resolved !== null &&
		(index.version !== resolved.version || index.integrity !== resolved.integrity)
	) {
		core.info(
			`The cache holds npm ${index.version}, not the resolved ${resolved.version}; downloading instead.`,
		);
		return null;
	}
	const choice = selectCandidate(specs, [candidate], installer.nodeVersion);
	if (choice.kind !== 'selected') {
		core.info(
			`The restored npm ${index.version} no longer satisfies the project; downloading instead.`,
		);
		return null;
	}
	const source: PackedSource = {
		file: join(artifactDir, index.tarball),
		published: {
			version: index.version,
			enginesNode: index.enginesNode,
			integrity: index.integrity,
			tarball: '',
			signatures: index.signatures,
			attestationsUrl: null,
		},
		publishedAt: async () => index.publishedAt,
		registry: index.registry,
	};
	const published = await installer.installTarball(choice.selection, source);
	return { ...published, version: index.version };
}

function report(result: ResolveResult, cliPath: string, cacheHit: boolean): void {
	pinForLaterSteps(result.version);
	emit({
		version: result.version,
		kind: result.kind,
		'cli-path': cliPath,
		'cache-hit': String(cacheHit),
	});
	core.info(
		`npm ${result.version} (${result.kind}${cacheHit ? ', from the Actions cache' : ''}): ${cliPath}`,
	);
	if (result.warning !== null) {
		core.warning(result.warning);
	}
}

function quietIo() {
	return {
		out: (text: string) => core.debug(text),
		err: (text: string) => core.warning(text),
		interactive: false,
		confirm: async () => false,
	};
}
