import { join, win32 } from 'node:path';
import { EXIT, NpmUseError } from '../errors.ts';

/** The launcher ABI the shims carry; a runtime declares the ABI it needs (spec RUN-2). */
export const SHIM_ABI = 1;

export const SHIM_DIR = 'shims';
export const SELECTORS = ['npm', 'npx', 'npm-use'] as const;
export type ShimName = (typeof SELECTORS)[number];

export interface ShimFile {
	/** File name inside `shims/`, with the Windows extension where there is one. */
	name: string;
	content: string;
	mode: number;
}

const UNSAFE = /[\n\r"'`$%!]/;

/** Refuses a home no quoting makes safe in all four shells and cmd (spec SET-2, M-HOMEPATH). */
export function assertSafeHome(home: string): void {
	const match = UNSAFE.exec(home);
	if (match !== null) {
		const shown = match[0] === '\n' || match[0] === '\r' ? 'a line break' : `"${match[0]}"`;
		throw new NpmUseError(
			'M-HOMEPATH',
			EXIT.usage,
			`The npm-use home ${home} contains ${shown}, which cannot be quoted safely in every shell. Set NPM_USE_HOME to a plain path and run setup again.`,
		);
	}
}

function selectorOf(name: ShimName): 'npm' | 'npx' | 'cli' {
	return name === 'npm-use' ? 'cli' : name;
}

/** The POSIX shim: `sh` on every OS, so Git Bash and MSYS on Windows get one too. */
export function posixShim(home: string, name: ShimName): string {
	const bootstrap = join(home, 'bootstrap.cjs');
	return `#!/bin/sh\n# npm-use launcher abi=${SHIM_ABI}\nexec node "${bootstrap}" ${selectorOf(name)} "$@"\n`;
}

/**
 * The cmd shim resolves node.exe through PATH only (`%~$PATH:i`): cmd would otherwise run a `node.exe`
 * committed to the current directory. One command line, so `%*` keeps its quoting.
 */
export function cmdShim(home: string, name: ShimName): string {
	const bootstrap = win32.join(home, 'bootstrap.cjs');
	const missing = 'echo npm-use: node.exe is not on PATH 1>&2 & exit /b 1';
	return [
		`@rem npm-use launcher abi=${SHIM_ABI}`,
		`@for %%i in (node.exe) do @if "%%~$PATH:i"=="" (${missing}) else @"%%~$PATH:i" "${bootstrap}" ${selectorOf(name)} %*`,
		'',
	].join('\r\n');
}

/** PowerShell never searches the current directory for a command, so `Get-Command` is enough. */
export function powershellShim(home: string, name: ShimName): string {
	const bootstrap = win32.join(home, 'bootstrap.cjs');
	return [
		`# npm-use launcher abi=${SHIM_ABI}`,
		'$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
		"if (-not $node) { [Console]::Error.WriteLine('npm-use: node.exe is not on PATH'); exit 1 }",
		`& $node.Source '${bootstrap}' ${selectorOf(name)} @args`,
		'exit $LASTEXITCODE',
		'',
	].join('\r\n');
}

/** Every shim file for the platform (spec SET-2); `.ps1` files are included only when the policy allows them (WIN-2). */
export function renderShims(
	home: string,
	platform: NodeJS.Platform,
	options: { powershell?: boolean } = {},
): ShimFile[] {
	assertSafeHome(home);
	const files: ShimFile[] = [];
	for (const name of SELECTORS) {
		files.push({ name, content: posixShim(home, name), mode: 0o755 });
		if (platform === 'win32') {
			files.push({ name: `${name}.cmd`, content: cmdShim(home, name), mode: 0o644 });
			if (options.powershell !== false) {
				files.push({ name: `${name}.ps1`, content: powershellShim(home, name), mode: 0o644 });
			}
		}
	}
	return files;
}

/** The ABI a shim file declares, or null when the file is not an npm-use shim. */
export function shimAbi(content: string): number | null {
	const match = /npm-use launcher abi=(\d+)/.exec(content);
	return match === null ? null : Number(match[1]);
}

export function shimDir(home: string): string {
	return join(home, SHIM_DIR);
}
