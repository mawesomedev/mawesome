import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { EXIT, NpmUseError } from '../errors.ts';
import { provenanceMessage } from '../messages.ts';
import type { NpmConfigView } from './config.ts';

/** What the attestation must say about this repository's release workflow (spec SUP-2). */
export const PROVENANCE_ISSUER = 'https://token.actions.githubusercontent.com';
export const PROVENANCE_IDENTITY =
	'https://github.com/mawesomedev/mawesome/.github/workflows/release.yml@refs/heads/main';
export const SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';

export interface ProvenanceInput {
	name: string;
	version: string;
	/** Hex sha512 of the tarball being installed. */
	sha512hex: string;
	/** `dist.attestations.url` from the packument; only its path is used (SUP-2). */
	attestationsUrl: string | null;
	config: NpmConfigView;
	stateDir: string;
}

export interface Attestation {
	predicateType: string;
	bundle: unknown;
}

export type AttestationFetcher = (url: URL, config: NpmConfigView) => Promise<Attestation[]>;
export type BundleVerifier = (bundle: unknown, options: { tufCachePath: string }) => Promise<void>;

function failure(name: string, version: string, detail: string): NpmUseError {
	return new NpmUseError(
		'M-PROVENANCE',
		EXIT.verification,
		provenanceMessage(name, version, detail),
	);
}

/** Resolves the attestation path against the configured registry: never another origin (spec SUP-2). */
export function attestationUrl(
	input: Pick<ProvenanceInput, 'name' | 'version' | 'attestationsUrl'>,
	registry: string,
): URL {
	const base = new URL(registry);
	const url = new URL(base);
	if (input.attestationsUrl !== null) {
		// Assigned, not re-parsed: a pathname starting with `//host` would otherwise become another origin.
		const given = new URL(input.attestationsUrl, base);
		url.pathname = given.pathname;
		url.search = given.search;
	} else {
		url.pathname = `${base.pathname.replace(/\/$/, '')}/-/npm/v1/attestations/${encodeURIComponent(input.name)}@${input.version}`;
		url.search = '';
	}
	url.hash = '';
	if (url.origin !== base.origin || url.username !== '' || url.password !== '') {
		throw new Error(`attestation URL ${url.href} leaves the registry origin ${base.origin}`);
	}
	return url;
}

/** TLS settings npm itself would use: `ca` and `cafile`, `strict-ssl`, and the registry's client certificate (spec DL-2). */
export function tlsOptions(config: NpmConfigView): {
	rejectUnauthorized: boolean;
	ca?: string[];
	cert?: string;
	key?: string;
} {
	const ca = [...(config.ca ?? [])];
	if (config.cafile !== null) {
		ca.push(readFileSync(config.cafile, 'utf8'));
	}
	const { certfile, keyfile } = config.credentials;
	return {
		rejectUnauthorized: config.strictSsl,
		...(ca.length === 0 ? {} : { ca }),
		...(certfile !== undefined && keyfile !== undefined
			? { cert: readFileSync(certfile, 'utf8'), key: readFileSync(keyfile, 'utf8') }
			: {}),
	};
}

function dispatcherFor(config: NpmConfigView, url: URL): Dispatcher {
	const proxy = url.protocol === 'https:' ? (config.httpsProxy ?? config.proxy) : config.proxy;
	const bypass = (config.noproxy ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '')
		.some((item) => url.hostname === item || url.hostname.endsWith(`.${item.replace(/^\./, '')}`));
	const tls = tlsOptions(config);
	if (proxy !== null && !bypass) {
		return new ProxyAgent({ uri: proxy, requestTls: tls });
	}
	return new Agent({ connect: tls });
}

function authHeader(config: NpmConfigView): Record<string, string> {
	const { token, username, password, auth } = config.credentials;
	if (token !== undefined) {
		return { authorization: `Bearer ${token}` };
	}
	if (auth !== undefined) {
		return { authorization: `Basic ${auth}` };
	}
	if (username !== undefined && password !== undefined) {
		return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
	}
	return {};
}

/** Fetches the attestations with the user's registry credentials, sent to that origin only (spec DL-2). */
export const fetchAttestations: AttestationFetcher = async (url, config) => {
	const dispatcher = dispatcherFor(config, url);
	try {
		const response = await request(url, {
			dispatcher,
			headers: { accept: 'application/json', ...authHeader(config) },
		});
		if (response.statusCode !== 200) {
			await response.body.dump();
			throw new Error(`registry answered ${response.statusCode} for ${url.pathname}`);
		}
		const body = (await response.body.json()) as { attestations?: unknown };
		const list = Array.isArray(body.attestations) ? body.attestations : [];
		return list.filter(
			(item): item is Attestation =>
				typeof item === 'object' &&
				item !== null &&
				typeof (item as Attestation).predicateType === 'string' &&
				'bundle' in item,
		);
	} finally {
		await dispatcher.close();
	}
};

/** sigstore's verifier with this repository's identity pinned; the TUF cache lives under the state dir. */
/** sigstore matches the identity as an unanchored regular expression, so the exact SAN is escaped and anchored. */
export function identityPattern(identity: string = PROVENANCE_IDENTITY): string {
	return `^${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export const verifyBundle: BundleVerifier = async (bundle, options) => {
	const sigstore = await import('sigstore');
	await sigstore.verify(bundle as Parameters<typeof sigstore.verify>[0], {
		certificateIssuer: PROVENANCE_ISSUER,
		certificateIdentityURI: identityPattern(),
		tufCachePath: options.tufCachePath,
	});
};

interface Statement {
	subject: Array<{ name: string; digest: Record<string, string> }>;
	predicateType: string;
}

function isSubject(value: unknown): value is Statement['subject'][number] {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const { name, digest } = value as { name?: unknown; digest?: unknown };
	return (
		typeof name === 'string' &&
		typeof digest === 'object' &&
		digest !== null &&
		!Array.isArray(digest)
	);
}

function statementOf(bundle: unknown): Statement | null {
	const payload = (bundle as { dsseEnvelope?: { payload?: unknown } }).dsseEnvelope?.payload;
	if (typeof payload !== 'string') {
		return null;
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(payload, 'base64').toString('utf8'),
		) as Partial<Statement>;
		if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.subject)) {
			return null;
		}
		return {
			predicateType: typeof parsed.predicateType === 'string' ? parsed.predicateType : '',
			subject: parsed.subject.filter(isSubject).map((subject) => ({
				name: subject.name,
				digest: Object.fromEntries(
					Object.entries(subject.digest).filter(([, value]) => typeof value === 'string'),
				) as Record<string, string>,
			})),
		};
	} catch {
		return null;
	}
}

/**
 * Verifies the SLSA provenance of a release (spec SUP-2): fetched from the registry origin, signed by this
 * repository's release workflow on main, and naming exactly this package version and tarball digest.
 */
export async function verifyProvenance(
	input: ProvenanceInput,
	deps: { fetch?: AttestationFetcher; verify?: BundleVerifier; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const { name, version } = input;
	let url: URL;
	try {
		url = attestationUrl(input, input.config.registry);
	} catch (error) {
		throw failure(name, version, `bad attestation URL: ${(error as Error).message}`);
	}
	let attestations: Attestation[];
	try {
		attestations = await (deps.fetch ?? fetchAttestations)(url, input.config);
	} catch (error) {
		throw failure(name, version, `cannot fetch attestations: ${(error as Error).message}`);
	}
	const provenance = attestations.find((item) => item.predicateType === SLSA_PREDICATE);
	if (provenance === undefined) {
		throw failure(name, version, 'the registry holds no SLSA provenance attestation for it');
	}
	const statement = statementOf(provenance.bundle);
	if (statement === null) {
		throw failure(name, version, 'the attestation bundle carries no readable in-toto statement');
	}
	// The registry's label is unsigned; the statement inside the envelope is what the signature covers.
	if (statement.predicateType !== SLSA_PREDICATE) {
		throw failure(
			name,
			version,
			`the signed statement is ${statement.predicateType}, not SLSA provenance`,
		);
	}
	// npm's provenance encodes the scope marker only: `pkg:npm/%40scope/name@version`.
	const expectedSubject = `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
	const subject = statement.subject.find((item) => item.name === expectedSubject);
	if (subject === undefined) {
		throw failure(
			name,
			version,
			`the attestation names ${statement.subject.map((item) => item.name).join(', ') || 'nothing'}, not ${expectedSubject}`,
		);
	}
	if (subject.digest['sha512'] !== input.sha512hex) {
		throw failure(name, version, 'the attested tarball digest differs from the downloaded tarball');
	}
	const tufCachePath = join(input.stateDir, 'sigstore');
	mkdirSync(tufCachePath, { recursive: true, mode: 0o700 });
	try {
		await withProxyEnv(input.config, deps.env ?? process.env, () =>
			(deps.verify ?? verifyBundle)(provenance.bundle, { tufCachePath }),
		);
	} catch (error) {
		throw failure(name, version, `signature verification failed: ${(error as Error).message}`);
	}
}

/**
 * sigstore fetches TUF metadata through make-fetch-happen, which reads proxy settings from the env (spec DL-2).
 * The npm config's proxy values are exposed only for the duration of the call.
 */
async function withProxyEnv<T>(
	config: NpmConfigView,
	env: NodeJS.ProcessEnv,
	run: () => Promise<T>,
): Promise<T> {
	const keys = ['https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'] as const;
	const saved = new Map(keys.map((key) => [key, env[key]]));
	const assign = (key: (typeof keys)[number], value: string | null): void => {
		if (value === null) {
			delete env[key];
		} else {
			env[key] = value;
		}
	};
	assign('https_proxy', config.httpsProxy ?? config.proxy);
	assign('http_proxy', config.proxy);
	assign('no_proxy', config.noproxy);
	assign('NODE_EXTRA_CA_CERTS', config.cafile);
	try {
		return await run();
	} finally {
		for (const [key, value] of saved) {
			assign(key, value ?? null);
		}
	}
}
