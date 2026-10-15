import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

export type FileType = 'file' | 'directory' | 'symlink' | 'other' | 'missing';
export type LineEndings = 'lf' | 'crlf' | 'mixed' | 'none';

/** What a target looked like at one moment (spec MUT-4), enough to tell our write from someone else's. */
export interface Meta {
	type: FileType;
	/** POSIX permission bits; Windows ACLs are left to the OS and recorded as 0. */
	mode: number;
	sha256: string | null;
	encoding: 'utf8' | 'binary' | null;
	lineEndings: LineEndings | null;
	symlinkTarget: string | null;
}

export function sha256(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

function isUtf8(content: Buffer): boolean {
	return !content.includes(0) && Buffer.from(content.toString('utf8'), 'utf8').equals(content);
}

export function lineEndingsOf(text: string): LineEndings {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	if (crlf === 0 && lf === 0) {
		return 'none';
	}
	if (crlf > 0 && lf > 0) {
		return 'mixed';
	}
	return crlf > 0 ? 'crlf' : 'lf';
}

export const MISSING: Meta = {
	type: 'missing',
	mode: 0,
	sha256: null,
	encoding: null,
	lineEndings: null,
	symlinkTarget: null,
};

/** Captures `path` without following symlinks; a missing path is a valid state, not an error. */
export function captureMeta(path: string): Meta {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return MISSING;
	}
	const mode = process.platform === 'win32' ? 0 : stat.mode & 0o7777;
	if (stat.isSymbolicLink()) {
		return {
			type: 'symlink',
			mode,
			sha256: null,
			encoding: null,
			lineEndings: null,
			symlinkTarget: readlinkSync(path),
		};
	}
	if (stat.isDirectory()) {
		return {
			type: 'directory',
			mode,
			sha256: null,
			encoding: null,
			lineEndings: null,
			symlinkTarget: null,
		};
	}
	if (!stat.isFile()) {
		return {
			type: 'other',
			mode,
			sha256: null,
			encoding: null,
			lineEndings: null,
			symlinkTarget: null,
		};
	}
	const content = readFileSync(path);
	const utf8 = isUtf8(content);
	return {
		type: 'file',
		mode,
		sha256: sha256(content),
		encoding: utf8 ? 'utf8' : 'binary',
		lineEndings: utf8 ? lineEndingsOf(content.toString('utf8')) : null,
		symlinkTarget: null,
	};
}

/** Whether the path still holds exactly what `meta` recorded (spec MUT-5): same type, same bytes or link target. */
export function metaMatches(path: string, meta: Meta): boolean {
	const now = captureMeta(path);
	return (
		now.type === meta.type && now.sha256 === meta.sha256 && now.symlinkTarget === meta.symlinkTarget
	);
}
