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
}

interface StoredVersion {
	version: string;
	manifest: Record<string, unknown>;
	tarball: Buffer;
	served: Buffer;
	integrity: string;
	shasum: string;
	signatures: Array<{ keyid: string; sig: string }>;
	time: string;
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

	constructor() {
		const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		this.privateKey = pair.privateKey;
		this.publicKey = pair.publicKey;
		const der = pair.publicKey.export({ format: 'der', type: 'spki' });
		this.publicKeyBase64 = der.toString('base64');
		this.keyid = `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
	}

	publish(version: string, options: PublishOptions = {}): StoredVersion {
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
		const manifest: Record<string, unknown> = { name: 'npm', version };
		if (options.engines !== undefined) {
			manifest['engines'] = { node: options.engines };
		}
		const signers =
			options.signers === 'none'
				? []
				: options.signers === undefined || options.signers === 'own'
					? [{ keyid: this.keyid, privateKey: this.privateKey }]
					: options.signers;
		const payload = Buffer.from(`npm@${version}:${integrity}`, 'utf8');
		const stored: StoredVersion = {
			version,
			manifest,
			tarball,
			served: options.tamperedTarball ?? tarball,
			integrity,
			shasum,
			signatures: signers.map((signer) => ({
				keyid: signer.keyid,
				sig: sign('sha256', payload, signer.privateKey).toString('base64'),
			})),
			time: options.time ?? '2026-01-01T00:00:00.000Z',
		};
		this.#versions.set(version, stored);
		return stored;
	}

	integrityOf(version: string): string {
		const stored = this.#versions.get(version);
		if (stored === undefined) {
			throw new Error(`not published: ${version}`);
		}
		return stored.integrity;
	}

	packument(): Record<string, unknown> {
		const versions: Record<string, unknown> = {};
		const time: Record<string, string> = {
			created: '2026-01-01T00:00:00.000Z',
			modified: '2026-01-01T00:00:00.000Z',
		};
		let latest = '0.0.0';
		for (const stored of this.#versions.values()) {
			versions[stored.version] = {
				...stored.manifest,
				_id: `npm@${stored.version}`,
				dist: {
					integrity: stored.integrity,
					shasum: stored.shasum,
					tarball: `${this.url}/npm/-/npm-${stored.version}.tgz`,
					signatures: stored.signatures,
				},
			};
			time[stored.version] = stored.time;
			latest = stored.version;
		}
		return { _id: 'npm', name: 'npm', 'dist-tags': { latest }, versions, time };
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
		if (path === '/npm') {
			return json(200, this.packument());
		}
		const tarball = /^\/npm\/-\/npm-(.+)\.tgz$/.exec(path);
		if (tarball !== null) {
			const stored = this.#versions.get(tarball[1] as string);
			if (stored !== undefined) {
				return { status: 200, body: stored.served, type: 'application/octet-stream' };
			}
		}
		return json(404, { error: 'Not found' });
	}
}

function json(status: number, body: unknown): { status: number; body: Buffer; type: string } {
	return { status, body: Buffer.from(JSON.stringify(body)), type: 'application/json' };
}
