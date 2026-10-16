import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	captureMeta,
	lineEndingsOf,
	metaMatches,
	MISSING,
	sha256,
} from '../../../src/state/meta.ts';
import { makeTree, removeTrees } from '../../helpers/tree.ts';

afterEach(removeTrees);

describe('captureMeta', () => {
	it('records files, directories, symlinks and missing paths', () => {
		const root = makeTree({
			'a.txt': 'line\r\nline\r\n',
			dir: {},
			bin: Buffer.from([0, 1, 2]).toString('latin1'),
		});
		writeFileSync(join(root, 'bin'), Buffer.from([0, 1, 2]));
		symlinkSync('a.txt', join(root, 'link'));
		expect(captureMeta(join(root, 'a.txt'))).toMatchObject({
			type: 'file',
			sha256: sha256('line\r\nline\r\n'),
			encoding: 'utf8',
			lineEndings: 'crlf',
		});
		expect(captureMeta(join(root, 'bin'))).toMatchObject({
			type: 'file',
			encoding: 'binary',
			lineEndings: null,
		});
		expect(captureMeta(join(root, 'dir'))).toMatchObject({ type: 'directory', sha256: null });
		expect(captureMeta(join(root, 'link'))).toMatchObject({
			type: 'symlink',
			symlinkTarget: 'a.txt',
		});
		expect(captureMeta(join(root, 'nope'))).toEqual(MISSING);
	});

	it('classifies line endings', () => {
		expect(lineEndingsOf('a\nb\n')).toBe('lf');
		expect(lineEndingsOf('a\r\nb\r\n')).toBe('crlf');
		expect(lineEndingsOf('a\r\nb\n')).toBe('mixed');
		expect(lineEndingsOf('a')).toBe('none');
	});

	it('matches only the same bytes of the same kind', () => {
		const root = makeTree({ 'a.txt': 'one' });
		const meta = captureMeta(join(root, 'a.txt'));
		expect(metaMatches(join(root, 'a.txt'), meta)).toBe(true);
		writeFileSync(join(root, 'a.txt'), 'two');
		expect(metaMatches(join(root, 'a.txt'), meta)).toBe(false);
		expect(metaMatches(join(root, 'gone'), MISSING)).toBe(true);
	});
});
