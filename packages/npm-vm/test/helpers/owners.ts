import { spawn, type ChildProcess } from 'node:child_process';
import { ownerRecord, type OwnerRecord } from '../../src/state/lease.ts';
import { startIdentity } from '../../src/state/proc.ts';

export const MACHINE: string = 'test-machine';

export function liveOwner(machineId: string = MACHINE): OwnerRecord {
	return ownerRecord(machineId);
}

/** Starts a Node process that idles until killed, so tests can own leases from another PID. */
export function idleProcess(): ChildProcess {
	return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

export function waitExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once('exit', () => resolve());
	});
}

/** An owner record whose process has already exited, with the start identity it had while alive. */
export async function deadOwner(machineId: string = MACHINE): Promise<OwnerRecord> {
	const child = idleProcess();
	await new Promise<void>((resolve) => child.once('spawn', resolve));
	const owner = ownerRecord(machineId, {
		pid: child.pid as number,
		start: startIdentity(child.pid as number),
	});
	child.kill('SIGKILL');
	await waitExit(child);
	return owner;
}

/** A live process whose recorded start identity differs, as after PID reuse. */
export async function reusedPidOwner(
	machineId: string = MACHINE,
): Promise<{ owner: OwnerRecord; child: ChildProcess }> {
	const child = idleProcess();
	await new Promise<void>((resolve) => child.once('spawn', resolve));
	return {
		owner: ownerRecord(machineId, { pid: child.pid as number, start: 'some other process' }),
		child,
	};
}

/** A live process that is stopped (SIGSTOP), which must still count as live. */
export async function suspendedOwner(
	machineId: string = MACHINE,
): Promise<{ owner: OwnerRecord; child: ChildProcess }> {
	const child = idleProcess();
	await new Promise<void>((resolve) => child.once('spawn', resolve));
	const owner = ownerRecord(machineId, {
		pid: child.pid as number,
		start: startIdentity(child.pid as number),
	});
	// Windows has no SIGSTOP; the child simply stays live there, which the assertions still require.
	if (process.platform !== 'win32') {
		child.kill('SIGSTOP');
	}
	return { owner, child };
}

export async function stop(child: ChildProcess): Promise<void> {
	if (process.platform !== 'win32') {
		child.kill('SIGCONT');
	}
	child.kill('SIGKILL');
	await waitExit(child);
}
