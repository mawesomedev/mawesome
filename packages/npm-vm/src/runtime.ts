import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { EXIT, isNpmVmError } from './errors.ts';
import { changedMessage, lockedMessage } from './messages.ts';
import { resolveNpmWith, type ResolveProviders } from './index.ts';
import type { Installer } from './install/index.ts';
import { findOwnNpm } from './own-npm.ts';
import type { Candidate } from './select.ts';

/** The launcher ABI this runtime needs; a launcher runs runtimes of its own ABI or one below (spec RUN-2). */
export const abi = 1;

export type Selector = 'npm' | 'npx' | 'cli';

export interface RuntimeOptions {
	home: string;
	launcherAbi: number;
}

/** Entry point `bootstrap.cjs` calls; returns the exit code. */
export async function main(
	selector: Selector,
	argv: string[],
	options: RuntimeOptions,
): Promise<number> {
	try {
		if (selector === 'cli') {
			const { run } = await import('./commands/dispatch.ts');
			return await run(argv, { home: options.home, env: process.env });
		}
		return await launch(selector, argv, options.home);
	} catch (error) {
		if (isNpmVmError(error)) {
			process.stderr.write(`npm-vm: ${error.message}\n`);
			return error.exitCode;
		}
		process.stderr.write(
			`npm-vm: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		return EXIT.problems;
	}
}

/**
 * Finishes journals left by a crashed command before anything else runs (spec RUN-2, MUT-2).
 * The lock is tried once without waiting: npm must never wait on a setup, and `current` is always runnable.
 */
async function recoverLeftovers(home: string): Promise<void> {
	const { resolveDirs } = await import('./setup/home.ts');
	const { hasJournals, recoverDeadJournals } = await import('./state/journal.ts');
	const { lockOwnerLive, readLock, tryLock } = await import('./state/lock.ts');
	const { ownerRecord } = await import('./state/lease.ts');
	const dirs = resolveDirs(process.env, home);
	if (!hasJournals(dirs.journal)) {
		return;
	}
	const owner = ownerRecord(dirs.machine.id);
	const lock = tryLock(dirs.state, owner);
	if (lock === null) {
		const holder = readLock(dirs.state);
		if (!lockOwnerLive(holder, dirs.machine.id)) {
			process.stderr.write(
				`npm-vm: ${lockedMessage(join(dirs.state, 'lock'), holder, false, false)}\n`,
			);
		}
		return;
	}
	try {
		const report = recoverDeadJournals(dirs.journal, dirs.machine.id);
		for (const id of report.changed) {
			process.stderr.write(`npm-vm: ${changedMessage(id, 'leftover change')}\n`);
		}
	} finally {
		lock.release();
	}
}

/** Resolves and runs npm or npx for the current directory (spec RUN-3 to RUN-7). */
async function launch(selector: 'npm' | 'npx', argv: string[], home: string): Promise<number> {
	const env = process.env;
	await recoverLeftovers(home);
	let installer: Promise<Installer> | null = null;
	// The install layer is a lazy chunk: a project satisfied by Node's own npm never parses it.
	const lazy = (): Promise<Installer> => {
		installer ??= import('./install/index.ts').then((install) =>
			install.createInstaller(install.createContext(env, home)),
		);
		return installer;
	};
	const providers: ResolveProviders = {
		nodeVersion: process.version,
		ownNpm: () => findOwnNpm(),
		cached: async (specs) => (await lazy()).cached(specs),
		registry: async (specs) => (await lazy()).registry(specs),
		entryPathFor: (candidate: Candidate) => join(home, 'pending', candidate.version),
	};
	const result = await resolveNpmWith(argv, process.cwd(), { env }, providers);
	if (result.warning !== null) {
		process.stderr.write(`npm-vm: ${result.warning}\n`);
	}
	const script = selector === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
	if (result.kind === 'own' || result.selection === null) {
		return runChild(join(dirname(result.cliPath), script), argv, null);
	}
	const ensured = await (await lazy()).ensure(result.selection);
	return runChild(join(ensured.entryPath, 'bin', script), argv, ensured.lease.release);
}

const FORWARD_NOW = ['SIGTERM', 'SIGHUP'] as const;
const FORWARD_LATER = ['SIGINT', 'SIGQUIT'] as const;
const LATER_DELAY_MS = 1000;

function alive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

/**
 * Spawns npm with inherited stdio and mirrors its exit (spec RUN-3 to RUN-5).
 * SIGTERM and SIGHUP are forwarded at once; SIGINT and SIGQUIT only if the child outlives them by a second, since a terminal already hit the whole group.
 */
export function runChild(
	script: string,
	argv: readonly string[],
	release: (() => void) | null,
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...argv], {
			stdio: 'inherit',
			env: process.env,
		});
		const handlers: Array<[NodeJS.Signals, () => void]> = [];
		const timers: NodeJS.Timeout[] = [];
		if (process.platform !== 'win32') {
			for (const signal of FORWARD_NOW) {
				handlers.push([signal, () => child.kill(signal)]);
			}
			for (const signal of FORWARD_LATER) {
				handlers.push([
					signal,
					() => {
						const timer = setTimeout(() => {
							if (alive(child)) {
								child.kill(signal);
							}
						}, LATER_DELAY_MS);
						timer.unref();
						timers.push(timer);
					},
				]);
			}
			for (const [signal, handler] of handlers) {
				process.on(signal, handler);
			}
		}
		const cleanup = (): void => {
			for (const [signal, handler] of handlers) {
				process.removeListener(signal, handler);
			}
			for (const timer of timers) {
				clearTimeout(timer);
			}
			release?.();
		};
		child.on('error', (error) => {
			cleanup();
			process.stderr.write(`npm-vm: cannot start ${script}: ${error.message}\n`);
			resolve(EXIT.problems);
		});
		child.on('exit', (code, signal) => {
			cleanup();
			if (signal !== null) {
				process.kill(process.pid, signal);
				return;
			}
			resolve(code ?? EXIT.problems);
		});
	});
}
