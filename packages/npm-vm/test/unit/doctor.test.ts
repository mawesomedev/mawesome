import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { winnerKind } from '../../src/commands/doctor.ts';
import { shellBinary } from '../../src/state/proc.ts';

describe('shellBinary', () => {
	it.skipIf(process.platform === 'win32')(
		'never consults PATH, only $SHELL and the system dirs',
		() => {
			const bash = shellBinary('bash', { PATH: '/nonexistent/node_modules/.bin' });
			expect(bash).not.toBeNull();
			expect(isAbsolute(bash as string)).toBe(true);
			expect(bash).not.toContain('node_modules');
			// A relative or mismatched $SHELL is ignored.
			expect(shellBinary('bash', { SHELL: 'bash' })).toBe(bash);
			expect(shellBinary('bash', { SHELL: '/bin/zsh' })).toBe(bash);
			// An absolute, matching $SHELL wins when it exists.
			expect(shellBinary('bash', { SHELL: bash as string })).toBe(bash);
			expect(shellBinary('bash', { SHELL: '/nonexistent/bash' })).toBe(bash);
		},
	);

	it('resolves pwsh to the Program Files install on Windows, never to PATH', () => {
		expect(shellBinary('bash', { PATH: 'C:\\x' }, 'win32')).toBeNull();
		expect(shellBinary('powershell', { ProgramFiles: 'C:\\nonexistent' }, 'win32')).toBeNull();
	});
});

describe('winnerKind', () => {
	it('tells an alias and a function from a PATH hit', () => {
		expect(winnerKind("alias npm='sfw npm'")).toBe('alias');
		expect(winnerKind('alias npm=npm')).toBe('alias');
		expect(winnerKind('npm')).toBe('function');
		expect(winnerKind('/home/me/.local/share/npm-vm/shims/npm')).toBe('path');
		expect(winnerKind('/usr/local/bin/npm')).toBe('path');
	});
});
