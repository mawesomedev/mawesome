import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { EXIT, NpmVmError } from '../errors.ts';
import { abiMessage } from '../messages.ts';
import { loadNpmConfig } from '../install/config.ts';
import { newWorkDir, Transport, transportUsable } from '../install/fetch.ts';
import { loadKeyring } from '../install/keys.ts';
import {
	verifyProvenance,
	type AttestationFetcher,
	type BundleVerifier,
} from '../install/provenance.ts';
import { fileDigests, safeExtract, verifySignatures } from '../install/verify.ts';
import { findOwnNpm } from '../own-npm.ts';
import { transportMessage } from '../messages.ts';
import { atomicWrite } from '../state/atomic.ts';
import { mutateFile, recoverDeadJournals } from '../state/journal.ts';
import { acquireLock } from '../state/lock.ts';
import {
	BOOTSTRAP_FILE,
	installVersion,
	PREVIOUS_FILE,
	readCurrent,
	readPrevious,
	runtimeAbi,
	versionDir,
} from '../setup/layout.ts';
import { executionPolicy } from '../setup/profile.ts';
import {
	LAUNCHERS_DIR,
	renderShims,
	shimAbi,
	shimDir,
	stalePowershellShims,
} from '../setup/shims.ts';
import { powershellAllowsScripts } from '../setup/windows.ts';
import type { CommandContext } from './context.ts';

export const PACKAGE_NAME = '@mawesome/npm-vm';

export interface SelfUpdateDeps {
	fetchAttestations?: AttestationFetcher;
	verifyBundle?: BundleVerifier;
}

export interface SelfUpdateOptions {
	rollback: boolean;
}

function run(
	file: string,
	args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[file, ...args],
			{ encoding: 'utf8', timeout: 60_000, windowsHide: true },
			(error, stdout, stderr) => {
				resolve({
					code:
						error === null
							? 0
							: (((error as { code?: number | string }).code as number | null) ?? 1),
					stdout,
					stderr,
				});
			},
		);
	});
}

/** The launcher generation a bootstrap file belongs to, read from its `LAUNCHER_ABI` constant. */
export function launcherAbiOf(bootstrapFile: string): number {
	const abi = shimAbi(readFileSync(bootstrapFile, 'utf8'));
	if (abi === null) {
		throw new NpmVmError(
			'M-ABI',
			EXIT.abi,
			abiMessage(`${bootstrapFile} declares no launcher ABI`),
		);
	}
	return abi;
}

/**
 * Replaces the home's launcher files with those of `version` (spec SUP-3): the bootstrap at the root and
 * every shim, rendered from that version's templates, each under a journal.
 */
export function installLaunchers(context: CommandContext, version: string): void {
	const { dirs, platform, env } = context;
	const dir = versionDir(dirs.home, version);
	const bootstrap = join(dir, BOOTSTRAP_FILE);
	const abi = launcherAbiOf(bootstrap);
	mutateFile(
		dirs.journal,
		'launcher',
		context.owner,
		join(dirs.home, BOOTSTRAP_FILE),
		readFileSync(bootstrap),
		0o644,
	);
	const powershell = platform !== 'win32' || powershellAllowsScripts(executionPolicy(env));
	mkdirSync(shimDir(dirs.home), { recursive: true, mode: 0o755 });
	for (const file of renderShims(dirs.home, platform, {
		powershell,
		templates: join(dir, LAUNCHERS_DIR),
		abi,
	})) {
		mutateFile(
			dirs.journal,
			'launcher',
			context.owner,
			join(shimDir(dirs.home), file.name),
			Buffer.from(file.content),
			file.mode,
		);
	}
	if (platform === 'win32' && !powershell) {
		for (const stale of stalePowershellShims(dirs.home)) {
			mutateFile(dirs.journal, 'launcher', context.owner, stale, null);
		}
	}
}

export function currentLauncherAbi(context: CommandContext): number | null {
	const file = join(context.dirs.home, BOOTSTRAP_FILE);
	return existsSync(file) ? shimAbi(readFileSync(file, 'utf8')) : null;
}

export async function selfUpdate(
	context: CommandContext,
	options: SelfUpdateOptions,
	deps: SelfUpdateDeps = {},
): Promise<number> {
	const lock = await acquireLock(context.dirs.state, context.owner);
	try {
		recoverDeadJournals(context.dirs.journal, context.dirs.machine.id);
		return options.rollback ? rollback(context) : await update(context, deps);
	} finally {
		lock.release();
	}
}

/** `self-update --rollback` (spec SUP-4): offline, swaps `current` back and restores the previous launchers if the ABI differs. */
function rollback(context: CommandContext): number {
	const { dirs, io } = context;
	const current = readCurrent(dirs.home);
	const previous = readPrevious(dirs.home);
	if (previous === null || !existsSync(versionDir(dirs.home, previous)) || current === null) {
		throw new NpmVmError('M-ABI', EXIT.usage, 'No previous version to roll back to.');
	}
	// The newer launcher still runs the previous runtime, so `current` moves first; the older launcher could not run the newer runtime.
	mutateFile(
		dirs.journal,
		'launcher',
		context.owner,
		join(dirs.home, 'current'),
		Buffer.from(`${previous}\n`),
	);
	if (
		launcherAbiOf(join(versionDir(dirs.home, previous), BOOTSTRAP_FILE)) !==
		currentLauncherAbi(context)
	) {
		installLaunchers(context, previous);
	}
	atomicWrite(join(dirs.home, PREVIOUS_FILE), `${current}\n`);
	io.out(
		context.json
			? JSON.stringify({ current: previous, previous: current })
			: `Rolled back to npm-vm ${previous} (from ${current}).`,
	);
	return EXIT.ok;
}

async function update(context: CommandContext, deps: SelfUpdateDeps): Promise<number> {
	const { dirs, env, io } = context;
	const installed = readCurrent(dirs.home) ?? context.version;
	const own = findOwnNpm();
	const found = own?.version ?? null;
	if (!transportUsable(own)) {
		throw new NpmVmError(
			'M-TRANSPORT',
			EXIT.transport,
			transportMessage(found, 'too old or missing'),
		);
	}
	const work = newWorkDir(dirs.tmp);
	try {
		const config = await loadNpmConfig(own, env, work);
		const transport = new Transport(own, config, env, dirs.tmp);
		const latest = (await transport.viewPackage(PACKAGE_NAME, 'latest'))[0];
		if (latest === undefined) {
			throw new NpmVmError(
				'M-TRANSPORT',
				EXIT.transport,
				transportMessage(own.version, `${PACKAGE_NAME}@latest is not published`),
			);
		}
		// Forward-only (SUP-1): a registry that serves an older "latest" cannot move the install back.
		if (!semver.gt(latest.version, installed)) {
			io.out(
				context.json
					? JSON.stringify({ current: installed, latest: latest.version, updated: false })
					: `npm-vm ${installed} is up to date (latest is ${latest.version}).`,
			);
			return EXIT.ok;
		}
		const packed = await transport.packPackage(PACKAGE_NAME, latest.version, work);
		const digests = await fileDigests(packed.file);
		if (digests.sha512 !== latest.integrity) {
			throw new NpmVmError(
				'M-INTEGRITY',
				EXIT.verification,
				`${PACKAGE_NAME}@${latest.version}: tarball does not match the registry integrity.`,
			);
		}
		await verifySignatures({
			name: PACKAGE_NAME,
			version: latest.version,
			integrity: latest.integrity,
			signatures: latest.signatures,
			publishedAt: async () => null,
			keys: loadKeyring(dirs.state),
			registry: config.registry,
			pinned: false,
		});
		await verifyProvenance(
			{
				name: PACKAGE_NAME,
				version: latest.version,
				sha512hex: digests.sha512hex,
				attestationsUrl: latest.attestationsUrl,
				config,
				stateDir: dirs.state,
			},
			{
				...(deps.fetchAttestations === undefined ? {} : { fetch: deps.fetchAttestations }),
				...(deps.verifyBundle === undefined ? {} : { verify: deps.verifyBundle }),
				env,
			},
		);
		const extracted = join(work, 'package');
		mkdirSync(extracted, { mode: 0o700 });
		await safeExtract(packed.file, extracted);
		const runtimeSource = join(extracted, 'dist', 'runtime');
		if (
			!existsSync(join(runtimeSource, 'runtime.cjs')) ||
			!existsSync(join(runtimeSource, BOOTSTRAP_FILE))
		) {
			throw new NpmVmError(
				'M-INTEGRITY',
				EXIT.verification,
				`${PACKAGE_NAME}@${latest.version} ships no runtime build.`,
			);
		}
		const candidateAbi = launcherAbiOf(join(runtimeSource, BOOTSTRAP_FILE));
		const installedRuntimeAbi =
			runtimeAbi(dirs.home, installed) ?? currentLauncherAbi(context) ?? candidateAbi;
		if (installedRuntimeAbi < candidateAbi - 1) {
			throw new NpmVmError(
				'M-ABI',
				EXIT.abi,
				abiMessage(
					`npm-vm ${latest.version} skips launcher generations (${installedRuntimeAbi} to ${candidateAbi})`,
				),
			);
		}
		const target = installVersion(dirs.home, latest.version, runtimeSource, candidateAbi);
		const health = await run(join(target, BOOTSTRAP_FILE), ['--candidate', 'cli', '--version']);
		if (health.code !== 0 || health.stdout.trim() !== latest.version) {
			rmSync(target, { recursive: true, force: true });
			throw new NpmVmError(
				'M-ABI',
				EXIT.abi,
				abiMessage(
					`the downloaded runtime failed its health check: ${health.stderr.trim() || health.stdout.trim() || `exit ${health.code}`}`,
				),
			);
		}
		if (candidateAbi !== currentLauncherAbi(context)) {
			installLaunchers(context, latest.version);
		}
		atomicWrite(join(dirs.home, PREVIOUS_FILE), `${installed}\n`);
		mutateFile(
			dirs.journal,
			'launcher',
			context.owner,
			join(dirs.home, 'current'),
			Buffer.from(`${latest.version}\n`),
		);
		io.out(
			context.json
				? JSON.stringify({ current: latest.version, previous: installed, updated: true })
				: `Updated npm-vm ${installed} to ${latest.version}.`,
		);
		return EXIT.ok;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
