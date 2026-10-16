import { describe, expect, it } from 'vitest';
import { winnerKind } from '../../src/commands/doctor.ts';

describe('winnerKind', () => {
	it('tells an alias and a function from a PATH hit', () => {
		expect(winnerKind("alias npm='sfw npm'")).toBe('alias');
		expect(winnerKind('alias npm=npm')).toBe('alias');
		expect(winnerKind('npm')).toBe('function');
		expect(winnerKind('/home/me/.local/share/npm-vm/shims/npm')).toBe('path');
		expect(winnerKind('/usr/local/bin/npm')).toBe('path');
	});
});
