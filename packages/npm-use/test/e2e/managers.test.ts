import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookSnippet, pathSnippet } from '../../src/setup/shell.ts';
import { command } from '../helpers/commands.ts';
import { createHarness, type Harness } from '../helpers/registry-harness.ts';
import { removeTrees } from '../helpers/tree.ts';

/*
 * Spec section 14: the launcher against real Node managers, where they are installed.
 * nvm runs from a private NVM_DIR borrowing the real nvm.sh and one Node, so link mode never touches the developer's install.
 */
const nvmDir = process.env['NVM_DIR'] ?? join(homedir(), '.nvm');
const nvmScript = join(nvmDir, 'nvm.sh');
const nvmNodes = existsSync(join(nvmDir, 'versions', 'node'))
	? readdirSync(join(nvmDir, 'versions', 'node')).filter((name) => /^v\d+/.test(name))
	: [];
const haveNvm = existsSync(nvmScript) && nvmNodes.length > 0;
const haveFnm = ((): boolean => {
	try {
		execFileSync('fnm', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) {
		await harness.close();
	}
	removeTrees();
});

/** Runs a bash script to completion; async so the fake registry keeps serving. */
function bash(
	script: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('bash', ['--noprofile', '--norc', '-c', script], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('exit', (status) => resolve({ status, stdout, stderr }));
	});
}

async function project(
	link: boolean,
): Promise<{ h: Harness; home: string; privateNvm: string; version: string }> {
	const h = await createHarness({
		devEngines: { packageManager: { name: 'npm', version: '13.0.0' } },
	});
	open.push(h);
	h.registry.publish('13.0.0');
	const home = h.context.dirs.home;
	// A private nvm: the real nvm.sh plus one real Node, linked in, so `nvm use` has something to switch to.
	const privateNvm = join(h.root, 'nvm');
	const version = nvmNodes[nvmNodes.length - 1] as string;
	const bin = join(privateNvm, 'versions', 'node', version, 'bin');
	mkdirSync(bin, { recursive: true });
	symlinkSync(nvmScript, join(privateNvm, 'nvm.sh'));
	const realBin = join(nvmDir, 'versions', 'node', version, 'bin');
	for (const name of readdirSync(realBin)) {
		symlinkSync(join(realBin, name), join(bin, name));
	}
	const env = { ...h.env, NVM_DIR: privateNvm, SHELL: '/bin/bash' };
	const args = ['setup', '--yes', '--no-modify-profile', ...(link ? ['--link'] : [])];
	const result = await command(args, { home, env, cwd: h.project });
	expect(result.code, result.stderr).toBe(0);
	return { h, home, privateNvm, version };
}

/** nvm refuses to run with PREFIX set, which the harness uses to isolate npm's global config. */
function nvmEnv(env: NodeJS.ProcessEnv, privateNvm: string): NodeJS.ProcessEnv {
	const { PREFIX: _prefix, ...rest } = env;
	return { ...rest, NVM_DIR: privateNvm, PATH: `/usr/bin:/bin:${process.env['PATH'] ?? ''}` };
}

describe.skipIf(!haveNvm)('nvm', { timeout: 120_000 }, () => {
	it('nvm use without a default alias prepends, and the prompt hook puts the shims back (scenario 10)', async () => {
		const { h, home, privateNvm, version } = await project(false);
		const script = [
			`source "${privateNvm}/nvm.sh" --no-use`,
			pathSnippet('bash', home),
			hookSnippet('bash', home),
			`nvm use ${version} >/dev/null`,
			'echo "after-use $(command -v npm)"',
			'_npm_use_guard',
			'echo "after-prompt $(command -v npm)"',
			'npm -v',
		].join('\n');
		const run = await bash(script, nvmEnv(h.env, privateNvm), h.project);
		expect(run.status, run.stderr).toBe(0);
		const lines = run.stdout.trim().split('\n');
		expect(lines[0]).toMatch(new RegExp(`^after-use .*/${version}/bin/npm$`));
		expect(lines[0]).not.toContain('shims');
		expect(lines[1]).toBe(`after-prompt ${join(home, 'shims', 'npm')}`);
		expect(lines[2]).toBe('13.0.0 -v');
	});

	it('with --link, nvm use && npm -v on one line already runs the shim (scenario 11)', async () => {
		const { h, home, privateNvm, version } = await project(true);
		const script = [
			`source "${privateNvm}/nvm.sh" --no-use`,
			pathSnippet('bash', home),
			`nvm use ${version} >/dev/null && npm -v && command -v npm`,
		].join('\n');
		const run = await bash(script, nvmEnv(h.env, privateNvm), h.project);
		expect(run.status, run.stderr).toBe(0);
		const lines = run.stdout.trim().split('\n');
		expect(lines[0]).toBe('13.0.0 -v');
		expect(lines[1]).toMatch(new RegExp(`/${version}/bin/npm$`));
	});
});

describe.skipIf(!haveFnm)('fnm', { timeout: 180_000 }, () => {
	it('a post-checkout hook running fnm use switches Node and keeps the shim first (scenario 9)', async () => {
		const h = await createHarness({
			devEngines: { packageManager: { name: 'npm', version: '13.0.0' } },
		});
		open.push(h);
		h.registry.publish('13.0.0');
		const home = h.context.dirs.home;
		const env = { ...h.env, SHELL: '/bin/bash' };
		expect(
			(await command(['setup', '--yes', '--no-modify-profile'], { home, env, cwd: h.project }))
				.code,
		).toBe(0);
		const installed = execFileSync('fnm', ['ls'], { encoding: 'utf8' })
			.split('\n')
			.map((line) => /v(\d+\.\d+\.\d+)/.exec(line)?.[1])
			.filter((version): version is string => version !== undefined);
		expect(
			installed.length,
			'the e2e workflow installs two Node lines for fnm',
		).toBeGreaterThanOrEqual(2);
		const [first, second] = installed as [string, string];
		const git = (...args: string[]) =>
			execFileSync('git', args, {
				cwd: h.project,
				stdio: 'ignore',
				env: {
					...process.env,
					GIT_AUTHOR_NAME: 'x',
					GIT_AUTHOR_EMAIL: 'x@x',
					GIT_COMMITTER_NAME: 'x',
					GIT_COMMITTER_EMAIL: 'x@x',
				},
			});
		git('init', '-q', '-b', 'a');
		writeFileSync(join(h.project, '.node-version'), `${first}\n`);
		git('add', '.');
		git('commit', '-q', '-m', 'a');
		git('checkout', '-q', '-b', 'b');
		writeFileSync(join(h.project, '.node-version'), `${second}\n`);
		git('commit', '-q', '-am', 'b');
		git('checkout', '-q', 'a');
		mkdirSync(join(h.project, '.git', 'hooks'), { recursive: true });
		writeFileSync(
			join(h.project, '.git', 'hooks', 'post-checkout'),
			'#!/bin/sh\nfnm use --silent-if-unchanged\n',
			{ mode: 0o755 },
		);
		const script = [
			'eval "$(fnm env --shell bash)"',
			pathSnippet('bash', home),
			'fnm use >/dev/null',
			'echo "before $(node -v)"',
			'git checkout -q b',
			'echo "after $(node -v)"',
			'command -v npm',
			'npm -v',
		].join('\n');
		const run = await bash(
			script,
			{ ...env, PATH: `/usr/bin:/bin:${process.env['PATH'] ?? ''}` },
			h.project,
		);
		expect(run.status, run.stderr).toBe(0);
		const lines = run.stdout.trim().split('\n');
		expect(lines[0]).toBe(`before v${first}`);
		expect(lines[1]).toBe(`after v${second}`);
		expect(lines[2]).toBe(join(home, 'shims', 'npm'));
		expect(lines[3]).toBe('13.0.0 -v');
	});
});
