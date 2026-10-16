import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRegistry } from '@mawesome/testing/registry';
import { serveRegistry } from '@mawesome/testing/registry/server';
import { resolveNpmWith, type ResolveResult } from '../../src/index.ts';
import {
	createContext,
	createInstaller,
	type InstallContext,
	type Installer,
} from '../../src/install/index.ts';
import type { RegistryKey } from '../../src/install/keys.ts';
import { findOwnNpm, type OwnNpm } from '../../src/own-npm.ts';
import { makeTree, manifest, type Tree } from './tree.ts';

/** A fake registry, an isolated npm config pointing at it, a private home and cache, and a project. */
export interface Harness {
	registry: FakeRegistry;
	root: string;
	project: string;
	env: NodeJS.ProcessEnv;
	context: InstallContext;
	installer: Installer;
	resolve(argv?: string[], cwd?: string): Promise<ResolveResult>;
	/** Resolves, makes the entry runnable and runs its npm-cli.js with `args`. */
	run(args?: string[]): Promise<{ result: ResolveResult; stdout: string; entryPath: string }>;
	close(): Promise<void>;
}

export interface HarnessOptions {
	devEngines?: unknown;
	packageManager?: string;
	projectFiles?: Tree;
	keys?: RegistryKey[];
	own?: OwnNpm | null;
	userNpmrc?: string;
	env?: NodeJS.ProcessEnv;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const registry = new FakeRegistry();
	const server = await serveRegistry(registry);
	const root = makeTree({
		home: {},
		cache: {},
		npmcache: {},
		prefix: {},
		user: {},
		project: {
			'package.json': manifest({
				...(options.devEngines === undefined ? {} : { devEngines: options.devEngines }),
				...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
			}),
			...options.projectFiles,
		},
	});
	writeFileSync(
		join(root, 'user', '.npmrc'),
		options.userNpmrc ??
			`registry=${server.url}/\ncache=${join(root, 'npmcache')}\nupdate-notifier=false\n`,
	);
	const env: NodeJS.ProcessEnv = {
		...cleanEnv(),
		HOME: join(root, 'user'),
		PREFIX: join(root, 'prefix'),
		XDG_CACHE_HOME: join(root, 'cache'),
		NPM_VM_HOME: join(root, 'home'),
		...options.env,
	};
	mkdirSync(join(root, 'home', 'state'), { recursive: true });
	writeFileSync(
		join(root, 'home', 'state', 'keys.json'),
		JSON.stringify(
			options.keys ?? [{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: null }],
		),
	);
	const base = createContext(env, join(root, 'home'));
	const context: InstallContext = {
		...base,
		own: options.own === undefined ? findOwnNpm() : options.own,
		keys: options.keys ?? [{ keyid: registry.keyid, key: registry.publicKeyBase64, expires: null }],
	};
	mkdirSync(context.dirs.cache, { recursive: true });
	const installer = createInstaller(context);
	const project = join(root, 'project');
	const resolve = (argv: string[] = [], cwd = project) =>
		resolveNpmWith(argv, cwd, { env }, installer);
	return {
		registry,
		root,
		project,
		env,
		context,
		installer,
		resolve,
		async run(args = ['-v']) {
			const result = await resolve();
			if (result.selection === null) {
				throw new Error(`expected a download or cached entry, got ${result.kind}`);
			}
			const { entryPath, lease } = await installer.ensure(result.selection);
			try {
				const stdout = execFileSync(
					process.execPath,
					[join(entryPath, 'bin', 'npm-cli.js'), ...args],
					{ encoding: 'utf8' },
				);
				return { result, stdout: stdout.trim(), entryPath };
			} finally {
				lease.release();
			}
		},
		close: server.close,
	};
}

/** The test's env without npm-specific variables or proxies that would steer the transport away from the fake. */
export function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^npm_/i.test(key) && !key.startsWith('NPM_VM_') && !/proxy$/i.test(key)) {
			env[key] = value;
		}
	}
	return env;
}
