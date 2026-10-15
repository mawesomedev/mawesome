import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { EXIT, NpmUseError } from '../errors.ts';
import { engineMessage, integrityMessage, transportMessage } from '../messages.ts';
import { findOwnNpm, type OwnNpm } from '../own-npm.ts';
import type { ResolveProviders } from '../index.ts';
import type { Candidate, Selection } from '../select.ts';
import type { NpmSpec } from '../spec.ts';
import { createLease, ownerRecord, type Lease } from '../state/lease.ts';
import { resolveDirs, type Dirs } from '../setup/home.ts';
import { canonicalEntry, listEntries, publishEntry, validateEntry } from './cache.ts';
import { loadNpmConfig, type NpmConfigView } from './config.ts';
import { newWorkDir, Transport, transportUsable, type RegistryVersion } from './fetch.ts';
import { loadKeyring, type RegistryKey } from './keys.ts';
import {
	checkIntegrity,
	fileDigests,
	safeExtract,
	verifySignatures,
	writeVerified,
} from './verify.ts';

export interface InstallContext {
	dirs: Dirs;
	own: OwnNpm | null;
	env: NodeJS.ProcessEnv;
	nodeVersion: string;
	keys: readonly RegistryKey[];
}

export function createContext(env: NodeJS.ProcessEnv = process.env, home?: string): InstallContext {
	const dirs = resolveDirs(env, home);
	return {
		dirs,
		own: findOwnNpm(),
		env,
		nodeVersion: process.version,
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
			throw new NpmUseError(
				'M-TRANSPORT',
				EXIT.transport,
				transportMessage(found, 'too old or missing'),
			);
		}
		const cwd = newWorkDir(dirs.tmp);
		try {
			const config = await loadNpmConfig(own, env, cwd);
			return { transport: new Transport(own, config, env, dirs.tmp), config };
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}

export interface Installer extends ResolveProviders {
	/** Makes the selected npm runnable: validates a cached entry or downloads, verifies and publishes one (spec SEC-4, SEC-5). */
	ensure(selection: Selection): Promise<{ entryPath: string; lease: Lease }>;
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

	return {
		nodeVersion: context.nodeVersion,
		ownNpm: () => context.own,
		cached: async () => listEntries(context.dirs.cache),
		registry: async (specs) => (await registryVersions(specs)).map(toCandidate),
		entryPathFor: (candidate) =>
			canonicalEntry(context.dirs.cache, candidate.version, candidate.integrity),
		async ensure(selection) {
			const { candidate } = selection;
			const owner = ownerRecord(context.dirs.machine.id);
			if (candidate.entryPath !== null && validateEntry(candidate.entryPath, candidate.integrity)) {
				return { entryPath: candidate.entryPath, lease: createLease(candidate.entryPath, owner) };
			}
			const { transport, config } = await factory.get();
			const published = (await transport.view(candidate.version)).find(
				(item) => item.version === candidate.version,
			);
			if (published === undefined || published.integrity !== candidate.integrity) {
				throw new NpmUseError(
					'M-INTEGRITY',
					EXIT.verification,
					integrityMessage(
						candidate.integrity,
						published?.integrity ?? 'nothing',
						`the registry no longer serves npm ${candidate.version} with this integrity`,
					),
				);
			}
			const work = newWorkDir(context.dirs.tmp);
			try {
				const packed = await transport.pack(candidate.version, work);
				const digests = await fileDigests(packed.file);
				checkIntegrity(digests, candidate.integrity, selection.hash);
				const keyid = await verifySignatures({
					name: 'npm',
					version: candidate.version,
					integrity: candidate.integrity,
					signatures: published.signatures,
					publishedAt: async () => (await transport.times())[candidate.version] ?? null,
					keys: context.keys,
					registry: config.registry,
					pinned: selection.hash !== null,
				});
				const extracted = join(work, 'package');
				mkdirSync(extracted, { mode: 0o700 });
				await safeExtract(packed.file, extracted);
				checkExtracted(extracted, candidate, context.nodeVersion);
				writeVerified(extracted, {
					version: candidate.version,
					integrity: candidate.integrity,
					keyid,
					verifiedAt: new Date().toISOString(),
				});
				const canonical = canonicalEntry(
					context.dirs.cache,
					candidate.version,
					candidate.integrity,
				);
				mkdirSync(join(canonical, '..'), { recursive: true, mode: 0o700 });
				return publishEntry(extracted, canonical, candidate.integrity, owner);
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
		throw new NpmUseError(
			'M-INTEGRITY',
			EXIT.verification,
			integrityMessage('npm package.json', 'unreadable', (error as Error).message),
		);
	}
	if (pkg['name'] !== 'npm' || pkg['version'] !== candidate.version) {
		throw new NpmUseError(
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
		throw new NpmUseError(
			'M-ENGINE',
			EXIT.resolution,
			engineMessage(candidate.version, node, nodeVersion),
		);
	}
}
