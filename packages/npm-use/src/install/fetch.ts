import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { EXIT, NpmUseError } from '../errors.ts';
import { integrityMessage, transportMessage } from '../messages.ts';
import type { OwnNpm } from '../own-npm.ts';
import type { RegistrySignature } from '../select.ts';
import { sanitizeEnv, type NpmConfigView } from './config.ts';

/** One published version as `npm view` reports it. */
export interface RegistryVersion {
	version: string;
	enginesNode: string | null;
	integrity: string;
	tarball: string;
	signatures: RegistrySignature[];
	/** `dist.attestations.url`, present for packages published with provenance. */
	attestationsUrl: string | null;
}

export interface PackedTarball {
	file: string;
	integrity: string;
}

const MIN_TRANSPORT = '8.0.0';
const MAX_OUTPUT = 256 * 1024 * 1024;

/** Whether Node's own npm can serve as the transport (spec DL-1). */
export function transportUsable(own: OwnNpm | null): own is OwnNpm {
	return own !== null && semver.gte(own.version, MIN_TRANSPORT);
}

/** A fresh private working dir under `state/tmp/`, never the shared system temp dir (spec DL-2). */
export function newWorkDir(tmpRoot: string): string {
	mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
	return mkdtempSync(join(tmpRoot, 'work-'));
}

/**
 * Runs Node's own npm as the download transport, isolated from the project (spec DL-1, DL-2).
 * Every call runs in its own empty working dir, with that dir as the prefix and the user and global config named explicitly.
 */
export class Transport {
	readonly #own: OwnNpm;
	readonly #config: NpmConfigView;
	readonly #env: NodeJS.ProcessEnv;
	readonly #tmpRoot: string;

	constructor(own: OwnNpm, config: NpmConfigView, env: NodeJS.ProcessEnv, tmpRoot: string) {
		this.#own = own;
		this.#config = config;
		this.#env = sanitizeEnv(env);
		this.#tmpRoot = tmpRoot;
	}

	/** Versions of npm matching `range`, newest last as npm lists them; an unmatched range is an empty list. */
	view(range: string): Promise<RegistryVersion[]> {
		return this.viewPackage('npm', range);
	}

	/** The same for any package, used by self-update for its own package. */
	async viewPackage(name: string, range: string): Promise<RegistryVersion[]> {
		const output = await this.#run(
			['view', `${name}@${range}`, 'version', 'engines', 'dist'],
			true,
		);
		if (output === null) {
			return [];
		}
		return asList(output).flatMap((item) => {
			const version = readString(item, 'version');
			const dist = readObject(item, 'dist');
			const integrity = dist === null ? null : readString(dist, 'integrity');
			const tarball = dist === null ? null : readString(dist, 'tarball');
			if (version === null || integrity === null || tarball === null) {
				return [];
			}
			const engines = readObject(item, 'engines');
			const signatures = (dist === null ? null : dist['signatures']) ?? [];
			const attestations = dist === null ? null : readObject(dist, 'attestations');
			return [
				{
					version,
					enginesNode: engines === null ? null : readString(engines, 'node'),
					integrity,
					tarball,
					signatures: Array.isArray(signatures) ? signatures.filter(isSignature) : [],
					attestationsUrl: attestations === null ? null : readString(attestations, 'url'),
				},
			];
		});
	}

	/** Publication time per version, used only to judge signatures by expired keys. */
	async times(): Promise<Record<string, string>> {
		const output = await this.#run(['view', 'npm', 'time'], true);
		const map = output === null ? null : (asList(output)[0] ?? null);
		const times: Record<string, string> = {};
		if (map !== null && typeof map === 'object') {
			for (const [version, time] of Object.entries(map)) {
				if (typeof time === 'string') {
					times[version] = time;
				}
			}
		}
		return times;
	}

	/** Downloads one npm version's tarball into `dest` through `npm pack`. */
	pack(version: string, dest: string): Promise<PackedTarball> {
		return this.packPackage('npm', version, dest);
	}

	async packPackage(name: string, version: string, dest: string): Promise<PackedTarball> {
		const output = await this.#run(
			['pack', `${name}@${version}`, `--pack-destination=${dest}`],
			false,
		);
		// npm 8 prints a list; npm 9 and later print an object keyed by package name.
		const items = asList(output).flatMap((item) =>
			readString(item, 'filename') === null ? asList(Object.values(item)) : [item],
		);
		const item = items.find((candidate) => readString(candidate, 'filename') !== null) ?? null;
		const filename = item === null ? null : readString(item, 'filename');
		const integrity = item === null ? null : readString(item, 'integrity');
		if (filename === null || integrity === null) {
			throw this.#failure(`npm pack returned no tarball for ${name}@${version}`);
		}
		return { file: join(dest, filename), integrity };
	}

	#failure(detail: string): NpmUseError {
		return new NpmUseError(
			'M-TRANSPORT',
			EXIT.transport,
			transportMessage(this.#own.version, detail),
		);
	}

	/** Runs npm with the isolation flags; returns parsed JSON, or null for a 404 when `missingIsEmpty`. */
	async #run(args: string[], missingIsEmpty: boolean): Promise<unknown> {
		const cwd = newWorkDir(this.#tmpRoot);
		const argv = [
			this.#own.cliPath,
			...args,
			'--json',
			'--ignore-scripts',
			'--loglevel=error',
			'--fetch-retry-mintimeout=1000',
			'--fetch-retry-maxtimeout=10000',
			`--prefix=${cwd}`,
			`--cache=${this.#config.cache}`,
			`--userconfig=${this.#config.userconfig}`,
			`--globalconfig=${this.#config.globalconfig}`,
		];
		try {
			const { stdout: output } = await new Promise<{ stdout: string }>((resolve, reject) => {
				execFile(
					process.execPath,
					argv,
					{ cwd, env: this.#env, maxBuffer: MAX_OUTPUT, timeout: 300_000, windowsHide: true },
					(error, stdout, stderr) => {
						if (error === null) {
							resolve({ stdout });
							return;
						}
						reject(Object.assign(error, { stdout, stderr }));
					},
				);
			});
			return parseJson(output);
		} catch (error) {
			const stderr = String((error as { stderr?: string }).stderr ?? '');
			if (missingIsEmpty && /\bE404\b/.test(stderr)) {
				return null;
			}
			const line = (
				stderr.split('\n').find((text) => /^npm (ERR!|error)/.test(text)) ??
				(error as Error).message
			)
				.replace(/^npm (ERR!|error) /, '')
				.trim();
			if (/\bEINTEGRITY\b/.test(stderr)) {
				throw new NpmUseError(
					'M-INTEGRITY',
					EXIT.verification,
					integrityMessage('the registry integrity', 'other bytes', line),
				);
			}
			throw this.#failure(line);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === '') {
		return null;
	}
	return JSON.parse(trimmed) as unknown;
}

function asList(value: unknown): Record<string, unknown>[] {
	const items = Array.isArray(value) ? value : [value];
	return items.filter(
		(item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
	);
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === 'string' ? value : null;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isSignature(value: unknown): value is RegistrySignature {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as RegistrySignature).keyid === 'string' &&
		typeof (value as RegistrySignature).sig === 'string'
	);
}
