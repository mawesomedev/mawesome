import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bootstrap.cjs');

describe('bootstrap.cjs', () => {
	const text = readFileSync(source, 'utf8');

	it('is valid JavaScript', () => {
		expect(spawnSync(process.execPath, ['--check', source]).status).toBe(0);
	});

	it('avoids syntax Node 10 cannot parse', () => {
		const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		for (const forbidden of [
			/=>/,
			/\blet\b/,
			/\bconst\b/,
			/`/,
			/\bclass\b/,
			/\basync\b/,
			/\bawait\b/,
			/\.\.\./,
			/\?\./,
			/\?\?/,
			/\bimport\b/,
		]) {
			expect(code, forbidden.source).not.toMatch(forbidden);
		}
	});

	it('names the floor and the ABI the runtime declares', () => {
		expect(text).toContain("FLOOR_TEXT = '22.9.0'");
		expect(text).toContain('FLOOR = [22, 9, 0]');
		expect(text).toContain('LAUNCHER_ABI = 1');
	});
});
