import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicRename, atomicWrite, withSharingRetry } from '../../../src/state/atomic.ts';
import { makeTree, removeTrees } from '../../helpers/tree.ts';

afterEach(removeTrees);

function busy(times: number): () => string {
	let calls = 0;
	return () => {
		calls += 1;
		if (calls <= times) {
			throw Object.assign(new Error('busy'), { code: 'EBUSY' });
		}
		return `ok after ${calls}`;
	};
}

function missing(): never {
	throw Object.assign(new Error('missing'), { code: 'ENOENT' });
}

describe('withSharingRetry', () => {
	it('retries Windows sharing violations and gives up at the limit', () => {
		expect(withSharingRetry(busy(2), 'win32')).toBe('ok after 3');
		expect(() => withSharingRetry(busy(100), 'win32', 150)).toThrow(/busy/);
	});

	it('does not retry on other platforms or other errors', () => {
		expect(() => withSharingRetry(busy(1), 'linux')).toThrow(/busy/);
		expect(() => withSharingRetry(missing, 'win32', 150)).toThrow(/missing/);
	});
});

describe('atomicWrite', () => {
	it('writes through a temp file and leaves none behind', () => {
		const root = makeTree({ 'a.txt': 'old' });
		atomicWrite(join(root, 'a.txt'), 'new');
		atomicWrite(join(root, 'deep', 'b.txt'), Buffer.from('bytes'), 0o600);
		expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new');
		expect(readFileSync(join(root, 'deep', 'b.txt'), 'utf8')).toBe('bytes');
		expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
		if (process.platform !== 'win32') {
			expect(statSync(join(root, 'deep', 'b.txt')).mode & 0o777).toBe(0o600);
		}
	});

	it('renames in place', () => {
		const root = makeTree({});
		writeFileSync(join(root, 'from'), 'x');
		atomicRename(join(root, 'from'), join(root, 'to'));
		expect(existsSync(join(root, 'from'))).toBe(false);
		expect(readFileSync(join(root, 'to'), 'utf8')).toBe('x');
	});
});
