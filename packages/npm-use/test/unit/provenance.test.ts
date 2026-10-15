import { describe, expect, it } from 'vitest';
import type { NpmConfigView } from '../../src/install/config.ts';
import {
	attestationUrl,
	PROVENANCE_IDENTITY,
	SLSA_PREDICATE,
	verifyProvenance,
	identityPattern,
	tlsOptions,
} from '../../src/install/provenance.ts';
import { join } from 'node:path';
import { makeTree } from '../helpers/tree.ts';

const config: NpmConfigView = {
	registry: 'https://registry.example/',
	userconfig: '/u',
	globalconfig: '/g',
	cache: '/c',
	credentials: { token: 'tok' },
	httpsProxy: null,
	proxy: null,
	noproxy: null,
	ca: null,
	cafile: null,
	strictSsl: true,
};

function bundleFor(subjectName: string, sha512: string): unknown {
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: [{ name: subjectName, digest: { sha512 } }],
		predicateType: SLSA_PREDICATE,
	};
	return {
		dsseEnvelope: {
			payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
			signatures: [],
		},
	};
}

const verify = async (): Promise<void> => undefined;

const input = {
	name: '@mawesome/npm-use',
	version: '1.2.3',
	sha512hex: 'ab'.repeat(64),
	attestationsUrl: null,
	config,
	stateDir: makeTree({}),
};

describe('attestationUrl', () => {
	it('anchors and escapes the identity sigstore matches as a regular expression', () => {
		const pattern = new RegExp(identityPattern());
		expect(pattern.test(PROVENANCE_IDENTITY)).toBe(true);
		expect(pattern.test(`${PROVENANCE_IDENTITY}-malicious`)).toBe(false);
		expect(
			pattern.test(
				`https://github.com/mawesomedev/mawesome/.github/workflows/releaseXyml@refs/heads/main`,
			),
		).toBe(false);
		expect(pattern.test(`x${PROVENANCE_IDENTITY}`)).toBe(false);
	});

	it('turns a malformed advertised URL into M-PROVENANCE', async () => {
		await expect(
			verifyProvenance(
				{ ...input, attestationsUrl: 'http://[' },
				{ fetch: async () => [], verify, env: {} },
			),
		).rejects.toMatchObject({ id: 'M-PROVENANCE' });
	});

	it('strips inline credentials from the request URL and from messages', async () => {
		const withCreds = { ...config, registry: 'https://user:secret@registry.example/' };
		const url = attestationUrl(input, withCreds.registry);
		expect(url.username).toBe('');
		expect(url.href).not.toContain('secret');
		const { redactUrls } = await import('../../src/messages.ts');
		expect(redactUrls('see https://user:secret@registry.example/x and http://a@b/')).toBe(
			'see https://***@registry.example/x and http://***@b/',
		);
		expect(redactUrls('https://user:p@ss@registry.example/')).toBe('https://***@registry.example/');
	});

	it('never follows an advertised path to another origin', () => {
		for (const evil of [
			'//evil.example/-/npm/v1/attestations/x',
			'https://registry.example//evil.example/x',
			'/x?y=1#frag',
		]) {
			const url = attestationUrl({ ...input, attestationsUrl: evil }, config.registry);
			expect(url.origin).toBe('https://registry.example');
			expect(url.hash).toBe('');
		}
	});

	it('rejects a statement whose subjects are malformed with M-PROVENANCE', async () => {
		const statement = {
			subject: [null, { name: 'x' }, { digest: {} }],
			predicateType: SLSA_PREDICATE,
		};
		const bundle = {
			dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
		};
		await expect(
			verifyProvenance(input, {
				fetch: async () => [{ predicateType: SLSA_PREDICATE, bundle }],
				verify,
				env: {},
			}),
		).rejects.toMatchObject({ id: 'M-PROVENANCE' });
	});

	it('keeps only the path of the advertised URL and resolves it against the registry', () => {
		const url = attestationUrl(
			{
				...input,
				attestationsUrl:
					'https://evil.example/-/npm/v1/attestations/%40mawesome%2Fnpm-use@1.2.3?x=1',
			},
			config.registry,
		);
		expect(url.toString()).toBe(
			'https://registry.example/-/npm/v1/attestations/%40mawesome%2Fnpm-use@1.2.3?x=1',
		);
		expect(attestationUrl(input, 'https://mirror.example/npm/').toString()).toBe(
			'https://mirror.example/npm/-/npm/v1/attestations/%40mawesome%2Fnpm-use@1.2.3',
		);
	});
});

describe('verifyProvenance', () => {
	it('accepts a matching SLSA statement and verifies the bundle with the pinned identity', async () => {
		const calls: unknown[] = [];
		await verifyProvenance(input, {
			fetch: async (url) => {
				calls.push(url.origin);
				return [
					{
						predicateType: SLSA_PREDICATE,
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.3', 'ab'.repeat(64)),
					},
				];
			},
			verify: async (bundle, options) => {
				calls.push({ bundle, cache: options.tufCachePath });
			},
			env: {},
		});
		expect(calls[0]).toBe('https://registry.example');
		expect(calls[1]).toMatchObject({ cache: expect.stringContaining('sigstore') });
		expect(PROVENANCE_IDENTITY).toBe(
			'https://github.com/mawesomedev/mawesome/.github/workflows/release.yml@refs/heads/main',
		);
	});

	it('rejects missing, mislabelled, mismatched and unverifiable attestations with M-PROVENANCE', async () => {
		await expect(
			verifyProvenance(input, { fetch: async () => [], verify, env: {} }),
		).rejects.toMatchObject({ id: 'M-PROVENANCE', exitCode: 5 });
		await expect(
			verifyProvenance(input, {
				fetch: async () => [
					{
						predicateType: 'https://other',
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.3', 'ab'.repeat(64)),
					},
				],
				verify,
				env: {},
			}),
		).rejects.toMatchObject({ id: 'M-PROVENANCE' });
		await expect(
			verifyProvenance(input, {
				fetch: async () => [
					{
						predicateType: SLSA_PREDICATE,
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.4', 'ab'.repeat(64)),
					},
				],
				verify,
				env: {},
			}),
		).rejects.toThrow(/not pkg:npm/);
		await expect(
			verifyProvenance(input, {
				fetch: async () => [
					{
						predicateType: SLSA_PREDICATE,
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.3', 'cd'.repeat(64)),
					},
				],
				verify,
				env: {},
			}),
		).rejects.toThrow(/digest differs/);
		await expect(
			verifyProvenance(input, {
				fetch: async () => [
					{
						predicateType: SLSA_PREDICATE,
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.3', 'ab'.repeat(64)),
					},
				],
				verify: async () => {
					throw new Error('bad signature');
				},
				env: {},
			}),
		).rejects.toThrow(/bad signature/);
		await expect(
			verifyProvenance(input, {
				fetch: async () => {
					throw new Error('offline');
				},
				verify,
				env: {},
			}),
		).rejects.toThrow(/cannot fetch attestations: offline/);
	});

	it('checks the predicate inside the signed statement, not only the registry label', async () => {
		const statement = {
			subject: [{ name: 'pkg:npm/%40mawesome/npm-use@1.2.3', digest: { sha512: 'ab'.repeat(64) } }],
			predicateType: 'https://other.example/v1',
		};
		const bundle = {
			dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
		};
		await expect(
			verifyProvenance(input, {
				fetch: async () => [{ predicateType: SLSA_PREDICATE, bundle }],
				verify,
				env: {},
			}),
		).rejects.toThrow(/not SLSA provenance/);
	});

	it('passes cafile and the registry client certificate to the fetch', () => {
		const root = makeTree({ 'ca.pem': 'CA', 'cert.pem': 'CERT', 'key.pem': 'KEY' });
		expect(
			tlsOptions({
				...config,
				ca: ['inline'],
				cafile: join(root, 'ca.pem'),
				credentials: { certfile: join(root, 'cert.pem'), keyfile: join(root, 'key.pem') },
			}),
		).toEqual({ rejectUnauthorized: true, ca: ['inline', 'CA'], cert: 'CERT', key: 'KEY' });
		expect(tlsOptions({ ...config, strictSsl: false })).toEqual({ rejectUnauthorized: false });
	});

	it('exposes the proxy settings to sigstore only for the duration of the call', async () => {
		const env: NodeJS.ProcessEnv = { https_proxy: 'http://old' };
		let seen: string | undefined;
		await verifyProvenance(
			{
				...input,
				config: { ...config, httpsProxy: 'http://proxy.example:3128', noproxy: 'internal' },
			},
			{
				fetch: async () => [
					{
						predicateType: SLSA_PREDICATE,
						bundle: bundleFor('pkg:npm/%40mawesome/npm-use@1.2.3', 'ab'.repeat(64)),
					},
				],
				verify: async () => {
					seen = `${env['https_proxy']} ${env['no_proxy']}`;
				},
				env,
			},
		);
		expect(seen).toBe('http://proxy.example:3128 internal');
		expect(env['https_proxy']).toBe('http://old');
		expect(env['no_proxy']).toBeUndefined();
	});
});
