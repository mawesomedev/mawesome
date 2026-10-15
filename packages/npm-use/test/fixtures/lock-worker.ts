/*
 * Takes the lock, appends an enter/leave pair to a shared log with a pause in between, releases.
 * Two of these running at once must never interleave their pairs.
 */
import { appendFileSync } from 'node:fs';
import { acquireLock } from '../../src/state/lock.ts';
import { ownerRecord } from '../../src/state/lease.ts';

const [stateDir, log, label] = process.argv.slice(2) as [string, string, string];
const lock = await acquireLock(stateDir, ownerRecord('worker-machine'), { waitMs: 10_000 });
appendFileSync(log, `enter ${label}\n`);
await new Promise((resolve) => setTimeout(resolve, 150));
appendFileSync(log, `leave ${label}\n`);
lock.release();
