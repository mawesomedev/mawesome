import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Builds `dist/` once per test run so the e2e suite launches the shipped runtime, not the sources. */
export default function setup(): void {
	execFileSync(process.execPath, [join(packageDir, 'node_modules', 'tsdown', 'dist', 'run.mjs')], {
		cwd: packageDir,
		stdio: ['ignore', 'ignore', 'inherit'],
	});
}
