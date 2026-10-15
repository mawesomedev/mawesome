import { describe, expect, it } from 'vitest';
import { ownNpmSatisfies, selectCandidate, sriHex, type Candidate } from '../../src/select.ts';
import { parseVersionSpec } from '../../src/spec.ts';

const integrity = `sha512-${Buffer.from('c'.repeat(128), 'hex').toString('base64')}`;
const hex = 'c'.repeat(128);

function candidate(
	version: string,
	enginesNode: string | null,
	entryPath: string | null = null,
): Candidate {
	return { version, enginesNode, integrity, entryPath, signatures: null };
}

describe('ownNpmSatisfies', () => {
	it('matches any spec without a hash and never a hashed one', () => {
		expect(ownNpmSatisfies('11.5.0', [parseVersionSpec('^11', 'f')])).toBe(true);
		expect(
			ownNpmSatisfies('11.5.0', [parseVersionSpec('^12', 'f'), parseVersionSpec('^11', 'f')]),
		).toBe(true);
		expect(ownNpmSatisfies('11.5.0', [parseVersionSpec(`11.5.0+sha512.${hex}`, 'f')])).toBe(false);
	});
});

describe('selectCandidate', () => {
	const node = 'v24.12.0';

	it('picks the highest version whose engines accept the active Node', () => {
		const result = selectCandidate(
			[parseVersionSpec('^12', 'f')],
			[
				candidate('12.0.0', '>=22'),
				candidate('12.2.0', '^22.22.2 || ^24.15.0 || >=26'),
				candidate('12.1.0', '>=24.12.0'),
			],
			node,
		);
		expect(result).toMatchObject({
			kind: 'selected',
			selection: { candidate: { version: '12.1.0' }, hash: null },
		});
	});

	it('reports the engines exclusion when only excluded versions match', () => {
		const result = selectCandidate(
			[parseVersionSpec('12.2.0', 'f')],
			[candidate('12.2.0', '^24.15.0')],
			node,
		);
		expect(result).toEqual({
			kind: 'failed',
			failure: { kind: 'engine', version: '12.2.0', enginesNode: '^24.15.0' },
		});
	});

	it('reports no match when nothing matches the specs', () => {
		const result = selectCandidate(
			[parseVersionSpec('^13', 'f')],
			[candidate('12.2.0', null)],
			node,
		);
		expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'nomatch' } });
	});

	it('unions alternatives regardless of order', () => {
		const specs = [parseVersionSpec('^12', 'f'), parseVersionSpec('^11', 'f')];
		const candidates = [candidate('11.9.0', null), candidate('12.1.0', null)];
		expect(selectCandidate(specs, candidates, node)).toMatchObject({
			selection: { candidate: { version: '12.1.0' } },
		});
		expect(selectCandidate(specs.toReversed(), candidates, node)).toMatchObject({
			selection: { candidate: { version: '12.1.0' } },
		});
	});

	it('lets a sha512 pin select only the version with that integrity', () => {
		const pinned = parseVersionSpec(`12.1.0+sha512.${hex}`, 'f');
		expect(selectCandidate([pinned], [candidate('12.1.0', null)], node)).toMatchObject({
			kind: 'selected',
			selection: { hash: { algorithm: 'sha512' } },
		});
		const other = {
			...candidate('12.1.0', null),
			integrity: `sha512-${Buffer.from('d'.repeat(128), 'hex').toString('base64')}`,
		};
		expect(selectCandidate([pinned], [other], node)).toMatchObject({
			kind: 'failed',
			failure: { kind: 'nomatch' },
		});
	});

	it('carries a sha256 pin to the verifier instead of deciding here', () => {
		const pinned = parseVersionSpec(`12.1.0+sha256.${'e'.repeat(64)}`, 'f');
		expect(selectCandidate([pinned], [candidate('12.1.0', null)], node)).toMatchObject({
			selection: { hash: { algorithm: 'sha256' } },
		});
	});

	it('prefers nothing by cache status; the caller asks the cache first', () => {
		const cached = candidate('12.0.0', null, '/cache/12.0.0');
		const result = selectCandidate(
			[parseVersionSpec('^12', 'f')],
			[cached, candidate('12.1.0', null)],
			node,
		);
		expect(result).toMatchObject({ selection: { candidate: { version: '12.1.0' } } });
	});
});

describe('sriHex', () => {
	it('decodes sha512 SRI and rejects other algorithms', () => {
		expect(sriHex(integrity)).toBe('c'.repeat(128));
		expect(sriHex('sha256-abc')).toBeNull();
	});
});
