import Config from '@npmcli/config';
import npmDefinitions from '@npmcli/config/lib/definitions/index.js';
import type { OwnNpm } from '../own-npm.ts';

/** The npm settings a download may use, read from user and global config only (spec DL-2). */
export interface NpmConfigView {
	registry: string;
	userconfig: string;
	globalconfig: string;
	cache: string;
	credentials: {
		token?: string;
		username?: string;
		password?: string;
		auth?: string;
		certfile?: string;
		keyfile?: string;
	};
	httpsProxy: string | null;
	proxy: string | null;
	noproxy: string | null;
	ca: string[] | null;
	cafile: string | null;
	strictSsl: boolean;
}

const DROPPED = new Set(['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']);
/** Proxy settings reach the transport only from the user and global npm config (spec DL-2), never the env. */
const PROXY_VARS = /^(https?_proxy|all_proxy|no_proxy|proxy)$/i;

/** The env without anything that would steer npm or Node: `npm_config_*`, proxies, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^npm_config_/i.test(key) || DROPPED.has(key.toUpperCase()) || PROXY_VARS.test(key)) {
			continue;
		}
		clean[key] = value;
	}
	return clean;
}

function optionalString(value: unknown): string | null {
	const text = Array.isArray(value)
		? value
				.map(String)
				.filter((item) => item !== '')
				.join(',')
		: value;
	return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * Loads npm's config the way npm does, minus the project: `cwd` is an empty dir under the home,
 * the env is sanitized and nothing is printed. Credentials come only from `getCredentialsByURI`.
 */
export async function loadNpmConfig(
	own: OwnNpm,
	env: NodeJS.ProcessEnv,
	cwd: string,
	nodePath: string = process.execPath,
): Promise<NpmConfigView> {
	const { definitions, shorthands, flatten, nerfDarts } = npmDefinitions;
	const config = new Config({
		definitions,
		shorthands,
		flatten,
		nerfDarts,
		npmPath: own.root,
		/* The global prefix and its npmrc belong to the Node the shims run, not to this process.
		 * Global mode makes the loader skip project config, so no ancestor of the home can inject an .npmrc. */
		argv: [nodePath, own.cliPath, '--location=global'],
		execPath: nodePath,
		env: { ...sanitizeEnv(env) },
		cwd,
		excludeNpmCwd: true,
	});
	await config.load();
	const registry = String(config.get('registry'));
	const ca = config.get('ca');
	return {
		registry,
		userconfig: String(config.get('userconfig')),
		globalconfig: String(config.get('globalconfig')),
		cache: String(config.get('cache')),
		credentials: config.getCredentialsByURI(registry),
		httpsProxy: optionalString(config.get('https-proxy')),
		proxy: optionalString(config.get('proxy')),
		noproxy: optionalString(config.get('noproxy')),
		ca: Array.isArray(ca) ? ca.map(String) : typeof ca === 'string' ? [ca] : null,
		cafile: optionalString(config.get('cafile')),
		strictSsl: config.get('strict-ssl') !== false,
	};
}
