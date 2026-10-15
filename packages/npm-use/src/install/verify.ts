import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
	createReadStream,
	createWriteStream,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import { EXIT, NpmUseError } from '../errors.ts';
import { integrityMessage, keyMessage, unsignedMessage } from '../messages.ts';
import type { RegistrySignature } from '../select.ts';
import type { SpecHash } from '../spec.ts';
import type { RegistryKey } from './keys.ts';

export interface Digests {
	/** `sha512-<base64>`, the SRI form the registry uses. */
	sha512: string;
	sha512hex: string;
	sha256hex: string;
	sha224hex: string;
}

/** Every digest a spec or the registry may ask for, in one pass over the file. */
export async function fileDigests(file: string): Promise<Digests> {
	const sha512 = createHash('sha512');
	const sha256 = createHash('sha256');
	const sha224 = createHash('sha224');
	await pipeline(
		createReadStream(file),
		new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				sha512.update(chunk);
				sha256.update(chunk);
				sha224.update(chunk);
				callback();
			},
		}),
	);
	const sha512Digest = sha512.digest();
	return {
		sha512: `sha512-${sha512Digest.toString('base64')}`,
		sha512hex: sha512Digest.toString('hex'),
		sha256hex: sha256.digest('hex'),
		sha224hex: sha224.digest('hex'),
	};
}

function integrityFailure(expected: string, actual: string, detail: string): NpmUseError {
	return new NpmUseError(
		'M-INTEGRITY',
		EXIT.verification,
		integrityMessage(expected, actual, detail),
	);
}

/** The tarball must match the registry's integrity and, when the project pins hashes, one of them (spec SEC-2). */
export function checkIntegrity(
	digests: Digests,
	integrity: string,
	hashes: readonly SpecHash[],
): void {
	if (digests.sha512 !== integrity.trim()) {
		throw integrityFailure(
			integrity,
			digests.sha512,
			'the tarball does not match the registry integrity',
		);
	}
	if (hashes.length === 0) {
		return;
	}
	const actual = {
		sha512: digests.sha512hex,
		sha256: digests.sha256hex,
		sha224: digests.sha224hex,
	};
	if (!hashes.some((hash) => actual[hash.algorithm] === hash.hex)) {
		const [first] = hashes as [SpecHash, ...SpecHash[]];
		throw integrityFailure(
			`${first.algorithm}.${first.hex}`,
			`${first.algorithm}.${actual[first.algorithm]}`,
			'the tarball does not match the pinned hash',
		);
	}
}

export interface SignatureInput {
	name: string;
	version: string;
	integrity: string;
	signatures: readonly RegistrySignature[];
	/** Resolves the publication time, consulted only when a signing key has expired. */
	publishedAt: () => Promise<string | null>;
	keys: readonly RegistryKey[];
	registry: string;
	/** A hash-pinned spec may accept an unsigned registry. */
	pinned: boolean;
}

/**
 * Checks the registry signatures over `name@version:integrity` against the pinned keyring (spec SEC-1).
 * Returns the key id that verified; throws M-KEY for an unknown key and M-UNSIGNED when no signature is usable.
 */
export async function verifySignatures(input: SignatureInput): Promise<string | null> {
	if (input.signatures.length === 0) {
		if (input.pinned) {
			return null;
		}
		throw new NpmUseError(
			'M-UNSIGNED',
			EXIT.verification,
			unsignedMessage(input.registry, input.version),
		);
	}
	const payload = Buffer.from(`${input.name}@${input.version}:${input.integrity}`, 'utf8');
	let unknown: string | null = null;
	for (const signature of input.signatures) {
		const key = input.keys.find((entry) => entry.keyid === signature.keyid);
		if (key === undefined) {
			unknown ??= signature.keyid;
			continue;
		}
		if (key.revoked === true || !(await keyCurrent(key, input.publishedAt))) {
			continue;
		}
		const publicKey = createPublicKey({
			key: Buffer.from(key.key, 'base64'),
			format: 'der',
			type: 'spki',
		});
		if (cryptoVerify('sha256', payload, publicKey, Buffer.from(signature.sig, 'base64'))) {
			return key.keyid;
		}
	}
	if (unknown !== null) {
		throw new NpmUseError('M-KEY', EXIT.verification, keyMessage(unknown));
	}
	throw new NpmUseError(
		'M-UNSIGNED',
		EXIT.verification,
		unsignedMessage(input.registry, input.version),
	);
}

/** An expired key still vouches for versions published before it expired; an unknown time fails closed. */
async function keyCurrent(
	key: RegistryKey,
	publishedAt: () => Promise<string | null>,
): Promise<boolean> {
	if (key.expires === null) {
		return true;
	}
	const published = await publishedAt();
	return published !== null && Date.parse(published) < Date.parse(key.expires);
}

export interface ExtractLimits {
	maxEntries: number;
	maxBytes: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxEntries: 10_000, maxBytes: 256 * 1024 * 1024 };

function unsafe(detail: string): NpmUseError {
	return integrityFailure('a safe npm tarball', 'an unsafe entry', detail);
}

/** The destination-relative path of a tarball entry, or a thrown M-INTEGRITY for anything outside `package/` (spec SEC-3). */
export function entryRelativePath(path: string): string {
	if (
		path.includes('\\') ||
		[...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
	) {
		throw unsafe(`entry name contains a control character or backslash: ${JSON.stringify(path)}`);
	}
	if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
		throw unsafe(`absolute entry name: ${path}`);
	}
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..')) {
		throw unsafe(`entry name climbs out of the archive: ${path}`);
	}
	if (segments[0] !== 'package') {
		throw unsafe(`entry outside package/: ${path}`);
	}
	return segments.length === 1 ? '' : posix.join(...segments.slice(1));
}

/**
 * Extracts regular files and directories under `package/` into `dest`, rejecting everything else (spec SEC-3).
 * Modes are `0644` or `0755` by the owner exec bit; ownership and extended attributes are ignored.
 */
export async function safeExtract(
	tarball: string,
	dest: string,
	limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<void> {
	let entries = 0;
	let bytes = 0;
	let decompressed = 0;
	const writes: Promise<void>[] = [];
	const parser = new Parser({ strict: true });
	let aborted: Error | null = null;
	const abort = (error: Error): void => {
		aborted ??= error;
		parser.abort(error);
	};
	parser.on('entry', (entry: ReadEntry) => {
		try {
			entries += 1;
			bytes += entry.size;
			if (entries > limits.maxEntries) {
				throw unsafe(`more than ${limits.maxEntries} entries`);
			}
			if (bytes > limits.maxBytes) {
				throw unsafe(`more than ${limits.maxBytes} bytes`);
			}
			const relative = entryRelativePath(entry.path);
			const target = relative === '' ? dest : join(dest, relative);
			if (entry.type === 'Directory') {
				mkdirSync(target, { recursive: true, mode: 0o755 });
				entry.resume();
				return;
			}
			if (entry.type !== 'File' || relative === '') {
				throw unsafe(`${entry.type} entry: ${entry.path}`);
			}
			mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
			const mode = ((entry.mode ?? 0o644) & 0o100) === 0 ? 0o644 : 0o755;
			writes.push(pipeline(entry, createWriteStream(target, { mode })));
		} catch (error) {
			abort(error as Error);
		}
	});
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			decompressed += chunk.length;
			if (decompressed > limits.maxBytes) {
				callback(unsafe(`more than ${limits.maxBytes} bytes after decompression`));
				return;
			}
			callback(null, chunk);
		},
	});
	const done = new Promise<void>((resolve, reject) => {
		parser.on('end', () => resolve());
		parser.on('error', (error: Error) => reject(error));
	});
	// The pipeline surfaces the same error first; the second rejection must not go unhandled.
	done.catch(() => undefined);
	try {
		await pipeline(createReadStream(tarball), createGunzip(), counter, parser);
		await done;
		await Promise.all(writes);
	} catch (error) {
		// Let in-flight file writes settle, so the caller can remove the destination at once.
		await Promise.allSettled(writes);
		throw (
			aborted ??
			(error instanceof NpmUseError
				? error
				: unsafe(`cannot read the tarball: ${(error as Error).message}`))
		);
	}
	if (aborted !== null) {
		throw aborted;
	}
}

/** The marker an entry carries once verified (spec SEC-4). */
export interface Verified {
	version: string;
	integrity: string;
	/** The registry key that verified the tarball, or null when only a project's pin did. */
	keyid: string | null;
	/** Tarball digests, so a later pin of another algorithm can be judged against the entry. */
	sha256: string;
	sha224: string;
	verifiedAt: string;
}

export const VERIFIED_FILE = '.verified';

export function writeVerified(dir: string, verified: Verified): void {
	writeFileSync(join(dir, VERIFIED_FILE), JSON.stringify(verified), { mode: 0o600 });
}

export function readVerified(dir: string): Verified | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, VERIFIED_FILE), 'utf8')) as Partial<Verified>;
		if (typeof parsed.version !== 'string' || typeof parsed.integrity !== 'string') {
			return null;
		}
		if (typeof parsed.sha256 !== 'string' || typeof parsed.sha224 !== 'string') {
			return null;
		}
		return {
			version: parsed.version,
			integrity: parsed.integrity,
			keyid: typeof parsed.keyid === 'string' ? parsed.keyid : null,
			sha256: parsed.sha256,
			sha224: parsed.sha224,
			verifiedAt: typeof parsed.verifiedAt === 'string' ? parsed.verifiedAt : '',
		};
	} catch {
		return null;
	}
}
