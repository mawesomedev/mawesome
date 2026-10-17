import semver from 'semver';

export type HashAlgorithm = 'sha512' | 'sha256' | 'sha224';

export interface SpecHash {
	algorithm: HashAlgorithm;
	hex: string;
}

/** One npm version requirement: a range, or an exact version optionally pinned to a tarball hash. */
export interface NpmSpec {
	/** The range as written, without any hash suffix. */
	range: string;
	/** Set when the range is a single exact version. */
	exact: string | null;
	hash: SpecHash | null;
}

export type OnFail = 'ignore' | 'warn' | 'error' | 'download';

export type SpecField = 'devEngines' | 'packageManager';

export interface ParsedSpecs {
	/** Alternatives: Node's own npm or a candidate satisfies the project when it matches any of them. */
	specs: NpmSpec[];
	/** The policy of the last `devEngines.packageManager` entry (spec RES-7); `error` for `packageManager`. */
	onFail: OnFail;
	field: SpecField;
}

export class SpecError extends Error {
	override name = 'SpecError';
	readonly field: string;
	/** The project's policy for this failure, when the entry declaring it could still be read. */
	onFail: OnFail = 'error';

	constructor(field: string, message: string) {
		super(message);
		this.field = field;
	}
}

const MAX_RANGE_LENGTH = 256;
const HASH_HEX_LENGTH: Record<HashAlgorithm, number> = { sha512: 128, sha256: 64, sha224: 56 };
const ON_FAIL = new Set<string>(['ignore', 'warn', 'error', 'download']);

/**
 * Validates one version string before it reaches a transport argv or a message (spec RES-4).
 * Build metadata other than a well-formed hash suffix is rejected: semver would silently drop it.
 */
export function parseVersionSpec(raw: string, field: string): NpmSpec {
	if (raw.length > MAX_RANGE_LENGTH) {
		throw new SpecError(field, `${field}: version is longer than ${MAX_RANGE_LENGTH} characters`);
	}
	const plus = raw.indexOf('+');
	const range = (plus === -1 ? raw : raw.slice(0, plus)).trim();
	let hash: SpecHash | null = null;
	if (plus !== -1) {
		hash = parseHash(raw.slice(plus + 1), field);
	}
	if (semver.validRange(range) === null) {
		throw new SpecError(field, `${field}: ${JSON.stringify(raw)} is not a semver range`);
	}
	const exact = semver.valid(range);
	if (hash !== null && exact === null) {
		throw new SpecError(
			field,
			`${field}: a hash needs an exact version, got ${JSON.stringify(raw)}`,
		);
	}
	return { range, exact, hash };
}

function parseHash(suffix: string, field: string): SpecHash {
	const match = /^(sha512|sha256|sha224)\.([0-9a-fA-F]+)$/.exec(suffix);
	if (match === null) {
		throw new SpecError(field, `${field}: unsupported hash suffix ${JSON.stringify(`+${suffix}`)}`);
	}
	const algorithm = match[1] as HashAlgorithm;
	const hex = (match[2] as string).toLowerCase();
	if (hex.length !== HASH_HEX_LENGTH[algorithm]) {
		throw new SpecError(
			field,
			`${field}: ${algorithm} hash must be ${HASH_HEX_LENGTH[algorithm]} hex characters`,
		);
	}
	return { algorithm, hex };
}

interface ManagerEntry {
	name?: unknown;
	version?: unknown;
	onFail?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the npm requirements of a parsed `package.json` (spec RES-4).
 * Returns null when the project declares nothing for npm, including when it declares only pnpm or yarn.
 */
export function parseSpecs(pkg: unknown): ParsedSpecs | null {
	if (!isObject(pkg)) {
		return null;
	}
	const devEngines = pkg['devEngines'];
	if (isObject(devEngines) && devEngines['packageManager'] !== undefined) {
		const fromDevEngines = parseDevEngines(devEngines['packageManager']);
		if (fromDevEngines !== null) {
			return fromDevEngines;
		}
	}
	const packageManager = pkg['packageManager'];
	if (typeof packageManager === 'string' && packageManager.startsWith('npm@')) {
		const field = 'packageManager';
		return {
			specs: [parseVersionSpec(packageManager.slice('npm@'.length), field)],
			onFail: 'error',
			field,
		};
	}
	return null;
}

function parseDevEngines(value: unknown): ParsedSpecs | null {
	const field = 'devEngines.packageManager';
	const entries = Array.isArray(value) ? value : [value];
	if (entries.length === 0) {
		return null;
	}
	const specs: NpmSpec[] = [];
	// The policy comes first, so an entry with a broken version still fails the way it asked to.
	const last = entries[entries.length - 1];
	const onFail = isObject(last) ? parseOnFail(last, field) : 'error';
	try {
		for (const entry of entries) {
			if (!isObject(entry)) {
				throw new SpecError(field, `${field}: every entry must be an object`);
			}
			if (entry['name'] !== 'npm') {
				continue;
			}
			const version = entry['version'];
			if (version === undefined) {
				specs.push({ range: '*', exact: null, hash: null });
			} else if (typeof version === 'string') {
				specs.push(parseVersionSpec(version, field));
			} else {
				throw new SpecError(field, `${field}: version must be a string`);
			}
		}
	} catch (error) {
		if (error instanceof SpecError) {
			error.onFail = onFail;
		}
		throw error;
	}
	if (specs.length === 0) {
		return null;
	}
	return { specs, onFail, field: 'devEngines' };
}

function parseOnFail(entry: ManagerEntry, field: string): OnFail {
	const onFail = entry.onFail;
	if (onFail === undefined) {
		return 'error';
	}
	if (typeof onFail !== 'string' || !ON_FAIL.has(onFail)) {
		throw new SpecError(field, `${field}: onFail must be ignore, warn, error or download`);
	}
	return onFail as OnFail;
}

/** Whether a concrete version satisfies the spec's range, hash aside (spec RES-5 and RES-6). */
export function matchesRange(version: string, spec: NpmSpec): boolean {
	return semver.satisfies(version, spec.range);
}
