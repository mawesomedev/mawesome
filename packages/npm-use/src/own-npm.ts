import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** The npm in the active Node's prefix: bundled, or whatever `npm i -g npm@x` put there. */
export interface OwnNpm {
	root: string;
	version: string;
	cliPath: string;
	npxCliPath: string;
}

/**
 * Locates Node's own npm from the running binary (spec section 1).
 * The lib dir, not the `bin/npm` link: under `--link` that link is the shim.
 */
export function ownNpmRoot(execPath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === 'win32') {
		return win32.join(win32.dirname(execPath), 'node_modules', 'npm');
	}
	let real = execPath;
	try {
		real = realpathSync(execPath);
	} catch {
		// A missing or unreadable binary resolves as given; the caller reports the missing npm.
	}
	return posix.join(posix.dirname(real), '..', 'lib', 'node_modules', 'npm');
}

export function findOwnNpm(
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): OwnNpm | null {
	const root = ownNpmRoot(execPath, platform);
	const { join } = platform === 'win32' ? win32 : posix;
	const manifest = join(root, 'package.json');
	if (!existsSync(manifest)) {
		return null;
	}
	let version: unknown;
	try {
		version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
	} catch {
		return null;
	}
	if (typeof version !== 'string') {
		return null;
	}
	return {
		root,
		version,
		cliPath: join(root, 'bin', 'npm-cli.js'),
		npxCliPath: join(root, 'bin', 'npx-cli.js'),
	};
}
