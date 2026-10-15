import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { buildTarball, npmPackageEntries, type TarEntry } from './tar.ts';

export interface PublishOptions {
	/** `engines.node` of the published manifest. */
	engines?: string;
	/** The exact tarball bytes; defaults to a minimal npm package. */
	tarball?: Buffer;
	/** Extra tar entries appended to the default package. */
	extra?: TarEntry[];
	/** Which keys sign the version: `own` (default), `none`, or a list of key ids with their signers. */
	signers?: 'own' | 'none' | Array<{ keyid: string; privateKey: KeyObject }>;
	/** Publication time for the packument's `time` map. */
	time?: string;
	/** Serve a different byte stream than the one the integrity describes. */
	tamperedTarball?: Buffer;
	/** Advertise the tarball on another origin, as a compromised registry could. */
	tarballOrigin?: string;
	/** Attestations the registry returns for this version; absent means a 404 like an unattested package. */
	attestations?: unknown[];
}

interface StoredVersion {
	name: string;
	version: string;
	manifest: Record<string, unknown>;
	tarball: Buffer;
	served: Buffer;
	integrity: string;
	shasum: string;
	signatures: Array<{ keyid: string; sig: string }>;
	time: string;
	tarballOrigin: string | null;
}

export interface RecordedRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
}

/** An npm registry serving one package, `npm`, with ECDSA signatures like registry.npmjs.org. */
export class FakeRegistry {
	readonly privateKey: KeyObject;
	readonly publicKey: KeyObject;
	readonly keyid: string;
	/** SPKI DER, base64, as the keys endpoint and the npm-use keyring hold it. */
	readonly publicKeyBase64: string;
	readonly requests: RecordedRequest[] = [];
	/** When set, requests without this bearer token get a 401. */
	token: string | null = null;
	/** Set by the server once it listens; tarball URLs point here. */
	url = 'http://registry.invalid';
	readonly #versions = new Map<string, StoredVersion>();
	readonly #packages = new Map<string, Map<string, StoredVersion>>();
	readonly #attestations = new Map<string, unknown[]>();

	constructor() {
		const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		this.privateKey = pair.privateKey;
		this.publicKey = pair.publicKey;
		const der = pair.publicKey.export({ format: 'der', type: 'spki' });
		this.publicKeyBase64 = der.toString('base64');
		this.keyid = `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
	}

	publish(version: string, options: PublishOptions = {}): StoredVersion {
		const stored = this.publishPackage('npm', version, options);
		this.#versions.set(version, stored);
		return stored;
	}

	/** Publishes any package; the registry serves its packument, tarballs and attestations like npm's. */
	publishPackage(name: string, version: string, options: PublishOptions = {}): StoredVersion {
		const tarball =
			options.tarball ??
			buildTarball(
				npmPackageEntries(version, {
					...(options.engines === undefined ? {} : { engines: options.engines }),
					...(options.extra === undefined ? {} : { extra: options.extra }),
				}),
			);
		const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
		const shasum = createHash('sha1').update(tarball).digest('hex');
		const manifest: Record<string, unknown> = { name, version };
		if (options.engines !== undefined) {
			manifest['engines'] = { node: options.engines };
		}
		const signers =
			options.signers === 'none'
				? []
				: options.signers === undefined || options.signers === 'own'
					? [{ keyid: this.keyid, privateKey: this.privateKey }]
					: options.signers;
		const payload = Buffer.from(`${name}@${version}:${integrity}`, 'utf8');
		const stored: StoredVersion = {
			name,
			version,
			manifest,
			tarball,
			served: options.tamperedTarball ?? tarball,
			tarballOrigin: options.tarballOrigin ?? null,
			integrity,
			shasum,
			signatures: signers.map((signer) => ({
				keyid: signer.keyid,
				sig: sign('sha256', payload, signer.privateKey).toString('base64'),
			})),
			time: options.time ?? '2026-01-01T00:00:00.000Z',
		};
		let versions = this.#packages.get(name);
		if (versions === undefined) {
			versions = new Map();
			this.#packages.set(name, versions);
		}
		versions.set(version, stored);
		if (options.attestations !== undefined) {
			this.#attestations.set(`${name}@${version}`, options.attestations);
		}
		return stored;
	}

	integrityOf(version: string): string {
		const stored = this.#versions.get(version);
		if (stored === undefined) {
			throw new Error(`not published: ${version}`);
		}
		return stored.integrity;
	}

	packument(name = 'npm'): Record<string, unknown> | null {
		const stored = this.#packages.get(name);
		if (stored === undefined) {
			return null;
		}
		const versions: Record<string, unknown> = {};
		const time: Record<string, string> = {
			created: '2026-01-01T00:00:00.000Z',
			modified: '2026-01-01T00:00:00.000Z',
		};
		let latest = '0.0.0';
		const file = name.startsWith('@') ? (name.split('/')[1] as string) : name;
		for (const entry of stored.values()) {
			const key = `${name}@${entry.version}`;
			versions[entry.version] = {
				...entry.manifest,
				_id: key,
				dist: {
					integrity: entry.integrity,
					shasum: entry.shasum,
					tarball: `${entry.tarballOrigin ?? this.url}/${name}/-/${file}-${entry.version}.tgz`,
					signatures: entry.signatures,
					...(this.#attestations.has(key)
						? {
								attestations: {
									url: `${this.url}/-/npm/v1/attestations/${encodeURIComponent(name)}@${entry.version}`,
								},
							}
						: {}),
				},
			};
			time[entry.version] = entry.time;
			latest = entry.version;
		}
		return { _id: name, name, 'dist-tags': { latest }, versions, time };
	}

	/** Answers one request the way the registry would; the npm CLI is the client. */
	fetch(
		method: string,
		path: string,
		headers: Record<string, string>,
	): { status: number; body: Buffer; type: string } {
		this.requests.push({ method, path, headers });
		if (this.token !== null && headers['authorization'] !== `Bearer ${this.token}`) {
			return json(401, { error: 'unauthorized' });
		}
		if (path === '/-/npm/v1/keys') {
			return json(200, {
				keys: [
					{
						expires: null,
						keyid: this.keyid,
						keytype: 'ecdsa-sha2-nistp256',
						scheme: 'ecdsa-sha2-nistp256',
						key: this.publicKeyBase64,
					},
				],
			});
		}
		const attested = /^\/-\/npm\/v1\/attestations\/(.+)$/.exec(path);
		if (attested !== null) {
			const list = this.#attestations.get(decodeURIComponent(attested[1] as string));
			return list === undefined
				? json(404, { error: 'Not found' })
				: json(200, { attestations: list });
		}
		const tarball = /^\/(@?[^/]+(?:\/[^/]+)?)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path);
		if (tarball !== null) {
			const stored = this.#packages
				.get(decodeURIComponent(tarball[1] as string))
				?.get(tarball[2] as string);
			if (stored !== undefined) {
				return { status: 200, body: stored.served, type: 'application/octet-stream' };
			}
		}
		const packument = this.packument(decodeURIComponent(path.slice(1)));
		if (packument !== null) {
			return json(200, packument);
		}
		return json(404, { error: 'Not found' });
	}
}

function json(status: number, body: unknown): { status: number; body: Buffer; type: string } {
	return { status, body: Buffer.from(JSON.stringify(body)), type: 'application/json' };
}
