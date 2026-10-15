import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNpmConfig, sanitizeEnv } from '../../src/install/config.ts';
import { findOwnNpm } from '../../src/own-npm.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

describe('sanitizeEnv', () => {
	it('drops npm_config_*, NODE_OPTIONS and NODE_EXTRA_CA_CERTS and keeps the rest', () => {
		const clean = sanitizeEnv({
			PATH: '/bin',
			npm_config_registry: 'http://evil',
			NPM_CONFIG_USERCONFIG: '/x',
			NODE_OPTIONS: '--require evil',
			node_extra_ca_certs: '/ca',
			HOME: '/home/me',
		});
		expect(clean).toEqual({ PATH: '/bin', HOME: '/home/me' });
	});
});

describe('loadNpmConfig', () => {
	it('reads user and global config and ignores the project and the env', async () => {
		const own = findOwnNpm();
		if (own === null) {
			throw new Error('no own npm');
		}
		const home = makeTree({
			'.npmrc': [
				'registry=https://user.example/',
				'//user.example/:_authToken=secret',
				'https-proxy=http://proxy.example:3128',
				'strict-ssl=false',
				'',
			].join('\n'),
			prefix: { etc: { npmrc: 'noproxy=internal.example\n' } },
			project: { '.npmrc': 'registry=https://project.example/\n', 'package.json': '{}' },
			work: {},
		});
		const env = {
			HOME: home,
			PREFIX: join(home, 'prefix'),
			npm_config_registry: 'https://env.example/',
			NPM_CONFIG_PROXY: 'http://env-proxy',
		};
		const config = await loadNpmConfig(own, env, join(home, 'work'));
		expect(config.registry).toBe('https://user.example/');
		expect(config.credentials).toEqual({ token: 'secret' });
		expect(config.httpsProxy).toBe('http://proxy.example:3128');
		expect(config.proxy).toBeNull();
		expect(config.noproxy).toBe('internal.example');
		expect(config.strictSsl).toBe(false);
		expect(config.userconfig).toBe(join(home, '.npmrc'));
		expect(config.globalconfig).toBe(join(home, 'prefix', 'etc', 'npmrc'));
		const inProject = await loadNpmConfig(own, env, join(home, 'project'));
		expect(inProject.registry).toBe('https://project.example/');
	});
});
