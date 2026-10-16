import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheBase, defaultHome } from '../../src/setup/home.ts';

describe('cache and home layout', () => {
	it('keeps the Windows cache beside the home, never inside it', () => {
		const env = { LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local') };
		const home = defaultHome(env, 'win32');
		const cache = cacheBase(env, 'win32');
		expect(home).toBe(join(env.LOCALAPPDATA, 'npm-vm'));
		expect(cache).toBe(join(env.LOCALAPPDATA, 'npm-vm-cache'));
		expect(cache.startsWith(`${home}${sep}`)).toBe(false);
	});

	it('follows XDG on POSIX', () => {
		const env = { XDG_DATA_HOME: '/d', XDG_CACHE_HOME: '/c' };
		expect(defaultHome(env, 'linux')).toBe(join('/d', 'npm-vm'));
		expect(cacheBase(env, 'linux')).toBe(join('/c', 'npm-vm'));
	});
});
