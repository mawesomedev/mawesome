import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBootstrap, installVersion, setCurrent } from '../../src/setup/layout.ts';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DIST_RUNTIME: string = join(packageDir, 'dist', 'runtime');
export const RUNTIME_VERSION: string = '0.0.0';

/** Lays out a home the way setup will: the runtime under `versions/`, `current`, and the launcher at the root. */
export function installHome(
	home: string,
	version: string = RUNTIME_VERSION,
	distDir: string = DIST_RUNTIME,
): string {
	installVersion(home, version, distDir, 1);
	setCurrent(home, version);
	installBootstrap(home, version);
	return join(home, 'bootstrap.cjs');
}

export interface Run {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** Runs the launcher to completion; asynchronous, because a synchronous spawn would block the fake registry's loop. */
export function runLauncher(
	home: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; node?: string },
): Promise<Run> {
	return startLauncher(home, args, options, () => undefined).done;
}

/** Starts the launcher without waiting, for signal tests; `stdout` lines arrive through `onLine`. */
export function startLauncher(
	home: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; node?: string },
	onLine: (line: string) => void,
): { child: ChildProcess; done: Promise<Run> } {
	const child = spawn(options.node ?? process.execPath, [join(home, 'bootstrap.cjs'), ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk: Buffer) => {
		stdout += chunk.toString();
		for (const line of chunk.toString().split('\n')) {
			if (line !== '') {
				onLine(line);
			}
		}
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const done = new Promise<Run>((resolve) => {
		child.on('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
	});
	return { child, done };
}

/** Other Node binaries nvm installed, so the launcher can be exercised on old and floor versions. */
export function installedNodes(): Array<{ version: string; path: string }> {
	const nvmDir = process.env['NVM_DIR'] ?? join(process.env['HOME'] ?? '', '.nvm');
	try {
		return readdirSync(join(nvmDir, 'versions', 'node'))
			.filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
			.map((name) => ({
				version: name.slice(1),
				path: join(nvmDir, 'versions', 'node', name, 'bin', 'node'),
			}));
	} catch {
		return [];
	}
}
