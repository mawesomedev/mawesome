import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { newToken } from './lease.ts';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_LIMIT_MS = 5000;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs a file operation, retrying Windows sharing violations with backoff for up to 5 s (spec MUT-3).
 * Elsewhere the same codes are real permission errors and surface at once.
 */
export function withSharingRetry<T>(
	operation: () => T,
	platform: NodeJS.Platform = process.platform,
	limitMs: number = RETRY_LIMIT_MS,
): T {
	const started = Date.now();
	let delay = 20;
	for (;;) {
		try {
			return operation();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (
				platform !== 'win32' ||
				!RETRY_CODES.has(code) ||
				Date.now() - started + delay > limitMs
			) {
				throw error;
			}
			sleepSync(delay);
			delay = Math.min(delay * 2, 500);
		}
	}
}

/** Writes `content` to `path` through a temp file in the same dir, fsynced and renamed into place. */
export function atomicWrite(path: string, content: string | Buffer, mode = 0o644): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `.${newToken()}.tmp`);
	try {
		const fd = openSync(temp, 'wx', mode);
		try {
			const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
			// writeSync may stop short without throwing; a truncated file must never reach the rename.
			for (let offset = 0; offset < buffer.length;) {
				const written = writeSync(fd, buffer, offset, buffer.length - offset);
				if (written <= 0) {
					throw new Error(`short write to ${temp}: ${offset} of ${buffer.length} bytes`);
				}
				offset += written;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		withSharingRetry(() => renameSync(temp, path));
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Renames with the Windows retry; a cross-device rename is not retried, it is a layout error. */
export function atomicRename(from: string, to: string): void {
	withSharingRetry(() => renameSync(from, to));
}

export function removeWithRetry(path: string): void {
	withSharingRetry(() => rmSync(path, { recursive: true, force: true }));
}
