import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { EXIT, NpmVmError } from '../errors.ts';
import { engineMessage, integrityMessage, transportMessage } from '../messages.ts';
import { findOwnNpm, type OwnNpm } from '../own-npm.ts';
import type { ResolveProviders } from '../index.ts';
import type { Candidate, Selection } from '../select.ts';
import type { NpmSpec } from '../spec.ts';
import { acquireShared, ownerRecord, type Lease } from '../state/lease.ts';
import { touchUsed } from '../state/prune.ts';
import { resolveDirs, type Dirs } from '../setup/home.ts';
import {
	canonicalEntry,
	listEntries,
	publishEntry,
	stagingDir,
	validateEntry,
	type PublishedEntry,
} from './cache.ts';
import { loadNpmConfig, type NpmConfigView } from './config.ts';
import { newWorkDir, Transport, transportUsable, type RegistryVersion } from './fetch.ts';
import { loadKeyring, type RegistryKey } from './keys.ts';
import {
	checkIntegrity,
	fileDigests,
	safeExtract,
	verifySignatures,
	writeVerified,
	type Digests,
} from './verify.ts';

export interface InstallContext {
	dirs: Dirs;
	own: OwnNpm | null;
	env: NodeJS.ProcessEnv;
	nodeVersion: string;
	/** The Node that runs the transport and, through the shims, npm itself. */
	nodePath: string;
	keys: readonly RegistryKey[];
}

export interface ContextNode {
	/** The Node binary the shims resolve through PATH; the Action passes the one setup-node installed. */
	execPath: string;
	version: string;
}

export function createContext(
	env: NodeJS.ProcessEnv = process.env,
	home?: string,
	node: ContextNode = { execPath: process.execPath, version: process.version },
): InstallContext {
	const dirs = resolveDirs(env, home);
	return {
		dirs,
		own: findOwnNpm(node.execPath),
		env,
		nodeVersion: node.version,
		nodePath: node.execPath,
		keys: loadKeyring(dirs.state),
	};
}

function toCandidate(version: RegistryVersion): Candidate {
	return {
		version: version.version,
		enginesNode: version.enginesNode,
		integrity: version.integrity,
		entryPath: null,
		signatures: version.signatures,
	};
}

/** Lazily loads the npm config and builds the transport once per process. */
class TransportFactory {
	readonly #context: InstallContext;
	#ready: Promise<{ transport: Transport; config: NpmConfigView }> | null = null;

	constructor(context: InstallContext) {
		this.#context = context;
	}

	get(): Promise<{ transport: Transport; config: NpmConfigView }> {
		this.#ready ??= this.#create();
		return this.#ready;
	}

	async #create(): Promise<{ transport: Transport; config: NpmConfigView }> {
		const { own, env, dirs } = this.#context;
		const found = own?.version ?? null;
		if (!transportUsable(own)) {
			throw new NpmVmError(
				'M-TRANSPORT',
				EXIT.transport,
				transportMessage(found, 'too old or missing'),
			);
		}
		const cwd = newWorkDir(dirs.tmp);
		try {
			const config = await loadNpmConfig(own, env, cwd, this.#context.nodePath);
			return {
				transport: new Transport(own, config, env, dirs.tmp, this.#context.nodePath),
				config,
			};
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}

/** A downloaded tarball plus what the registry said about it, ready for verification. */
export interface PackedSource {
	file: string;
	published: RegistryVersion;
	publishedAt: () => Promise<string | null>;
	registry: string;
}

export interface EnsureOptions {
	/** Called with the verified tarball before it is extracted, so a caller can keep a copy (the Action's cache). */
	onPacked?: (source: PackedSource, digests: Digests) => Promise<void>;
}

export interface Installer extends ResolveProviders {
	/** Makes the selected npm runnable: validates a cached entry or downloads, verifies and publishes one (spec SEC-4, SEC-5). */
	ensure(
		selection: Selection,
		options?: EnsureOptions,
	): Promise<{ entryPath: string; lease: Lease }>;
	/** Verifies and publishes a tarball obtained elsewhere, such as a restored CI cache (spec SEC-1 to SEC-5). */
	installTarball(selection: Selection, source: PackedSource): Promise<PublishedEntry>;
	/** A short stable id of the configured registry, for cache keys that must not mix registries. */
	registryIdentity(): Promise<string>;
}

export function createInstaller(context: InstallContext): Installer {
	const factory = new TransportFactory(context);

	async function registryVersions(specs: readonly NpmSpec[]): Promise<RegistryVersion[]> {
		const { transport } = await factory.get();
		const byVersion = new Map<string, RegistryVersion>();
		for (const spec of specs) {
			for (const version of await transport.view(spec.exact ?? spec.range)) {
				byVersion.set(version.version, version);
			}
		}
		return [...byVersion.values()];
	}

	async function installTarball(
		selection: Selection,
		source: PackedSource,
		onPacked?: EnsureOptions['onPacked'],
	): Promise<PublishedEntry> {
		const { candidate } = selection;
		const owner = ownerRecord(context.dirs.machine.id);
		if (
			source.published.version !== candidate.version ||
			source.published.integrity !== candidate.integrity
		) {
			throw new NpmVmError(
				'M-INTEGRITY',
				EXIT.verification,
				integrityMessage(
					candidate.integrity,
					source.published.integrity,
					`the registry no longer serves npm ${candidate.version} with this integrity`,
				),
			);
		}
		const digests = await fileDigests(source.file);
		checkIntegrity(digests, candidate.integrity, selection.hashes);
		const keyid = await verifySignatures({
			name: 'npm',
			version: candidate.version,
			integrity: candidate.integrity,
			signatures: source.published.signatures,
			publishedAt: source.publishedAt,
			keys: context.keys,
			registry: source.registry,
			pinned: selection.hashes.length > 0,
		});
		if (onPacked !== undefined) {
			await onPacked(source, digests);
		}
		// Extracted on the cache's own filesystem: the final rename into the cache must not cross one (EXDEV).
		const work = newWorkDir(stagingDir(context.dirs.cache));
		try {
			const extracted = join(work, 'package');
			mkdirSync(extracted, { mode: 0o700 });
			await safeExtract(source.file, extracted);
			checkExtracted(extracted, candidate, context.nodeVersion);
			writeVerified(extracted, {
				version: candidate.version,
				integrity: candidate.integrity,
				keyid,
				sha256: digests.sha256hex,
				sha224: digests.sha224hex,
				verifiedAt: new Date().toISOString(),
			});
			const canonical = canonicalEntry(context.dirs.cache, candidate.version, candidate.integrity);
			mkdirSync(join(canonical, '..'), { recursive: true, mode: 0o700 });
			const published = publishEntry(extracted, canonical, candidate.integrity, owner);
			touchUsed(published.entryPath);
			return published;
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	return {
		nodeVersion: context.nodeVersion,
		ownNpm: () => context.own,
		cached: async () => listEntries(context.dirs.cache, context.keys),
		registry: async (specs) => (await registryVersions(specs)).map(toCandidate),
		entryPathFor: (candidate) =>
			canonicalEntry(context.dirs.cache, candidate.version, candidate.integrity),
		async registryIdentity() {
			const { config } = await factory.get();
			return createHash('sha256').update(config.registry).digest('hex').slice(0, 12);
		},
		installTarball: (selection, source) => installTarball(selection, source),
		async ensure(selection, options = {}) {
			const { candidate } = selection;
			const owner = ownerRecord(context.dirs.machine.id);
			if (candidate.entryPath !== null && validateEntry(candidate.entryPath, candidate.integrity)) {
				const lease = await acquireShared(candidate.entryPath, owner);
				// A live prune gate means the entry is on its way out; fetch a private copy instead of waiting.
				if (lease !== null && validateEntry(candidate.entryPath, candidate.integrity)) {
					touchUsed(candidate.entryPath);
					return { entryPath: candidate.entryPath, lease };
				}
				lease?.release();
			}
			const { transport, config } = await factory.get();
			const published = (await transport.view(candidate.version)).find(
				(item) => item.version === candidate.version,
			);
			if (published === undefined) {
				throw new NpmVmError(
					'M-INTEGRITY',
					EXIT.verification,
					integrityMessage(
						candidate.integrity,
						'nothing',
						`the registry no longer serves npm ${candidate.version}`,
					),
				);
			}
			const work = newWorkDir(context.dirs.tmp);
			try {
				const packed = await transport.pack(candidate.version, work);
				const source: PackedSource = {
					file: packed.file,
					published,
					publishedAt: async () => (await transport.times())[candidate.version] ?? null,
					registry: config.registry,
				};
				return await installTarball(selection, source, options.onPacked);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		},
	};
}

/** The extracted manifest is authoritative for name, version and engines (spec SEC-5). */
function checkExtracted(dir: string, candidate: Candidate, nodeVersion: string): void {
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
	} catch (error) {
		throw new NpmVmError(
			'M-INTEGRITY',
			EXIT.verification,
			integrityMessage('npm package.json', 'unreadable', (error as Error).message),
		);
	}
	if (pkg['name'] !== 'npm' || pkg['version'] !== candidate.version) {
		throw new NpmVmError(
			'M-INTEGRITY',
			EXIT.verification,
			integrityMessage(
				`npm@${candidate.version}`,
				`${String(pkg['name'])}@${String(pkg['version'])}`,
				'the tarball holds a different package',
			),
		);
	}
	const engines = pkg['engines'];
	const node =
		typeof engines === 'object' && engines !== null
			? (engines as Record<string, unknown>)['node']
			: undefined;
	if (
		typeof node === 'string' &&
		!semver.satisfies(nodeVersion, node, { includePrerelease: true })
	) {
		throw new NpmVmError(
			'M-ENGINE',
			EXIT.resolution,
			engineMessage(candidate.version, node, nodeVersion),
		);
	}
}
