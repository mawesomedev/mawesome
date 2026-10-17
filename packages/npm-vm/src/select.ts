import semver from 'semver';
import { matchesRange, type NpmSpec, type SpecHash } from './spec.ts';

export interface RegistrySignature {
	keyid: string;
	sig: string;
}

/** A published npm version as the registry or the cache describes it. */
export interface Candidate {
	version: string;
	/** `engines.node` of the package; missing means any Node. */
	enginesNode: string | null;
	/** `dist.integrity` (sha512 SRI). */
	integrity: string;
	/** Where the candidate lives when it is already cached. */
	entryPath: string | null;
	/** `dist.signatures` from the registry; null for a cached candidate. */
	signatures: RegistrySignature[] | null;
	/** For a cached entry: the key that verified it, or null when only a project's pin did. */
	keyid?: string | null;
	/** For a cached entry: the tarball digests recorded at verification, so a pin can be judged without the bytes. */
	digests?: { sha256: string; sha224: string } | null;
}

export interface Selection {
	candidate: Candidate;
	/** Pins from the specs that selected the candidate; the download must match one of them. Empty: unpinned. */
	hashes: SpecHash[];
}

export type SelectFailure =
	| { kind: 'engine'; version: string; enginesNode: string }
	| { kind: 'nomatch'; reason: string };

export type SelectResult =
	| { kind: 'selected'; selection: Selection }
	| { kind: 'failed'; failure: SelectFailure };

function engineAccepts(candidate: Candidate, nodeVersion: string): boolean {
	return (
		candidate.enginesNode === null ||
		semver.satisfies(nodeVersion, candidate.enginesNode, { includePrerelease: true })
	);
}

function hashAccepts(candidate: Candidate, spec: NpmSpec): boolean {
	if (spec.hash === null) {
		// An entry that only a pin ever vouched for is not an alternative for an unpinned project (spec SEC-1).
		return candidate.keyid !== null;
	}
	if (spec.hash.algorithm === 'sha512') {
		return sriHex(candidate.integrity) === spec.hash.hex;
	}
	if (candidate.digests === undefined || candidate.digests === null) {
		// Only the tarball bytes can answer a sha256 or sha224 pin; verification checks it after download.
		return true;
	}
	return candidate.digests[spec.hash.algorithm] === spec.hash.hex;
}

/** The hex digest of a `sha512-<base64>` SRI string, or null for any other form. */
export function sriHex(integrity: string): string | null {
	const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
	return match === null ? null : Buffer.from(match[1] as string, 'base64').toString('hex');
}

/** Whether Node's own npm satisfies a spec without a hash (spec RES-5). */
export function ownNpmSatisfies(ownVersion: string, specs: readonly NpmSpec[]): boolean {
	return specs.some((spec) => spec.hash === null && matchesRange(ownVersion, spec));
}

/**
 * Picks the highest candidate matching any spec and the active Node (spec RES-6), cached first.
 * Returns the reason when nothing fits, distinguishing an `engines.node` exclusion from no match at all.
 */
export function selectCandidate(
	specs: readonly NpmSpec[],
	candidates: readonly Candidate[],
	nodeVersion: string,
): SelectResult {
	let best: Selection | null = null;
	let excluded: Candidate | null = null;
	for (const candidate of candidates) {
		const matching = specs.filter(
			(entry) => matchesRange(candidate.version, entry) && hashAccepts(candidate, entry),
		);
		if (matching.length === 0) {
			continue;
		}
		if (!engineAccepts(candidate, nodeVersion)) {
			if (excluded === null || semver.gt(candidate.version, excluded.version)) {
				excluded = candidate;
			}
			continue;
		}
		if (best === null || semver.gt(candidate.version, best.candidate.version)) {
			// An unpinned alternative needs no pin; otherwise every matching pin is carried and any one may verify.
			const unpinned = matching.some((entry) => entry.hash === null);
			best = {
				candidate,
				hashes: unpinned
					? []
					: matching.flatMap((entry) => (entry.hash === null ? [] : [entry.hash])),
			};
		}
	}
	if (best !== null) {
		return { kind: 'selected', selection: best };
	}
	if (excluded !== null) {
		return {
			kind: 'failed',
			failure: {
				kind: 'engine',
				version: excluded.version,
				enginesNode: excluded.enginesNode ?? '*',
			},
		};
	}
	return { kind: 'failed', failure: { kind: 'nomatch', reason: 'no published version matches' } };
}
