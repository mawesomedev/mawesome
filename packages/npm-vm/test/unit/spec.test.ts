import { describe, expect, it } from 'vitest';
import { parseSpecs, parseVersionSpec, SpecError } from '../../src/spec.ts';

const sha512 = 'a'.repeat(128);

describe('parseVersionSpec', () => {
	it('accepts ranges and exact versions', () => {
		expect(parseVersionSpec('^12.0.0', 'f')).toEqual({ range: '^12.0.0', exact: null, hash: null });
		expect(parseVersionSpec('12.x', 'f').exact).toBeNull();
		expect(parseVersionSpec('12.2.0', 'f').exact).toBe('12.2.0');
		expect(parseVersionSpec('*', 'f').range).toBe('*');
	});

	it('parses a hash suffix on an exact version', () => {
		const spec = parseVersionSpec(`12.2.0+sha512.${sha512.toUpperCase()}`, 'f');
		expect(spec).toEqual({
			range: '12.2.0',
			exact: '12.2.0',
			hash: { algorithm: 'sha512', hex: sha512 },
		});
		expect(parseVersionSpec(`12.2.0+sha224.${'b'.repeat(56)}`, 'f').hash?.algorithm).toBe('sha224');
	});

	it('rejects what is not a range: tags, URLs, overlong input, bad hashes', () => {
		for (const bad of [
			'latest',
			'https://evil.example/npm.tgz',
			'git+ssh://git@github.com/npm/cli',
			'x'.repeat(257),
			`^12+sha512.${sha512}`,
			`12.2.0+sha512.${'a'.repeat(127)}`,
			`12.2.0+md5.${'a'.repeat(32)}`,
			'12.2.0+build.1',
			'12.2.0 --registry=http://evil',
		]) {
			expect(() => parseVersionSpec(bad, 'devEngines.packageManager'), bad).toThrow(SpecError);
		}
	});
});

describe('parseSpecs', () => {
	it('reads the object form with its onFail', () => {
		const parsed = parseSpecs({
			devEngines: { packageManager: { name: 'npm', version: '^12', onFail: 'warn' } },
		});
		expect(parsed).toEqual({
			specs: [{ range: '^12', exact: null, hash: null }],
			onFail: 'warn',
			field: 'devEngines',
		});
	});

	it('keeps npm entries of the array form in order and takes onFail from the last entry of any name', () => {
		const parsed = parseSpecs({
			devEngines: {
				packageManager: [
					{ name: 'npm', version: '^11' },
					{ name: 'npm', version: '^12', onFail: 'error' },
					{ name: 'pnpm', version: '^10', onFail: 'warn' },
				],
			},
		});
		expect(parsed?.specs.map((spec) => spec.range)).toEqual(['^11', '^12']);
		expect(parsed?.onFail).toBe('warn');
	});

	it('treats a missing version as any version', () => {
		expect(parseSpecs({ devEngines: { packageManager: { name: 'npm' } } })?.specs[0]?.range).toBe(
			'*',
		);
	});

	it('returns null when only another package manager is declared', () => {
		expect(
			parseSpecs({ devEngines: { packageManager: { name: 'pnpm', version: '^10' } } }),
		).toBeNull();
		expect(parseSpecs({ packageManager: 'pnpm@10.0.0' })).toBeNull();
		expect(parseSpecs({ devEngines: { packageManager: [] } })).toBeNull();
		expect(parseSpecs({})).toBeNull();
		expect(parseSpecs(null)).toBeNull();
	});

	it('falls back to packageManager only without npm entries in devEngines', () => {
		expect(parseSpecs({ packageManager: `npm@12.2.0+sha512.${sha512}` })).toEqual({
			specs: [{ range: '12.2.0', exact: '12.2.0', hash: { algorithm: 'sha512', hex: sha512 } }],
			onFail: 'error',
			field: 'packageManager',
		});
		const both = parseSpecs({
			packageManager: 'npm@10.0.0',
			devEngines: { packageManager: { name: 'npm', version: '^12' } },
		});
		expect(both?.field).toBe('devEngines');
		const pnpmOnly = parseSpecs({
			packageManager: 'npm@10.0.0',
			devEngines: { packageManager: { name: 'pnpm', version: '^10' } },
		});
		expect(pnpmOnly?.field).toBe('packageManager');
	});

	it('attaches the declared policy to a broken version so the caller can honour it', () => {
		try {
			parseSpecs({
				devEngines: {
					packageManager: [
						{ name: 'npm', version: 'latest' },
						{ name: 'pnpm', onFail: 'warn' },
					],
				},
			});
			throw new Error('expected a SpecError');
		} catch (error) {
			expect(error).toBeInstanceOf(SpecError);
			expect((error as SpecError).onFail).toBe('warn');
			expect((error as SpecError).message).toContain('"latest"');
		}
		expect(() =>
			parseSpecs({ devEngines: { packageManager: { name: 'npm', version: '\u001b[31mred' } } }),
		).toThrow(/\\u001b/);
	});

	it('rejects malformed entries', () => {
		expect(() => parseSpecs({ devEngines: { packageManager: 'npm' } })).toThrow(SpecError);
		expect(() =>
			parseSpecs({ devEngines: { packageManager: { name: 'npm', version: 12 } } }),
		).toThrow(SpecError);
		expect(() =>
			parseSpecs({ devEngines: { packageManager: { name: 'npm', onFail: 'retry' } } }),
		).toThrow(SpecError);
	});
});
