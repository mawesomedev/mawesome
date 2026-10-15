import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { EXIT, NpmUseError } from '../errors.ts';

/** The launcher ABI the shims carry; a runtime declares the ABI it needs (spec RUN-2). */
export const SHIM_ABI = 1;

export const SHIM_DIR = 'shims';
export const LAUNCHERS_DIR = 'launchers';
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

/**
 * The launcher templates shipped beside this code: `src/launchers/` from source, `dist/runtime/launchers/`
 * from the bin, and `launchers/` beside an installed `runtime.cjs`.
 */
export function templatesDir(): string {
	const here = import.meta.dirname;
	for (const candidate of [
		join(here, LAUNCHERS_DIR),
		join(here, '..', LAUNCHERS_DIR),
		join(here, 'runtime', LAUNCHERS_DIR),
	]) {
		if (existsSync(join(candidate, 'sh.tmpl'))) {
			return candidate;
		}
	}
	throw new Error(`npm-use launcher templates not found near ${here}`);
}

export type TemplateKind = 'sh' | 'cmd' | 'ps1';

export function readTemplate(dir: string, kind: TemplateKind): string {
	return readFileSync(join(dir, `${kind}.tmpl`), 'utf8');
}

/** Fills one launcher template; the ABI comes from the launcher generation the templates belong to. */
export function renderTemplate(
	template: string,
	values: { bootstrap: string; selector: string; abi: number },
): string {
	return template
		.replace(/\{\{ABI\}\}/g, String(values.abi))
		.replace(/\{\{BOOTSTRAP\}\}/g, values.bootstrap)
		.replace(/\{\{SELECTOR\}\}/g, values.selector);
}

/** The POSIX shim: `sh` on every OS, so Git Bash and MSYS on Windows get one too. */
export function posixShim(
	home: string,
	name: ShimName,
	templates: string = templatesDir(),
	abi: number = SHIM_ABI,
): string {
	return renderTemplate(readTemplate(templates, 'sh'), {
		bootstrap: join(home, 'bootstrap.cjs'),
		selector: selectorOf(name),
		abi,
	});
}

/**
 * The cmd shim resolves node.exe through PATH only (`%~$PATH:i`): cmd would otherwise run a `node.exe`
 * committed to the current directory. One command line, so `%*` keeps its quoting.
 */
export function cmdShim(
	home: string,
	name: ShimName,
	templates: string = templatesDir(),
	abi: number = SHIM_ABI,
): string {
	return renderTemplate(readTemplate(templates, 'cmd'), {
		bootstrap: win32.join(home, 'bootstrap.cjs'),
		selector: selectorOf(name),
		abi,
	});
}

/** PowerShell never searches the current directory for a command, so `Get-Command` is enough. */
export function powershellShim(
	home: string,
	name: ShimName,
	templates: string = templatesDir(),
	abi: number = SHIM_ABI,
): string {
	return renderTemplate(readTemplate(templates, 'ps1'), {
		bootstrap: win32.join(home, 'bootstrap.cjs'),
		selector: selectorOf(name),
		abi,
	});
}

export interface RenderOptions {
	powershell?: boolean;
	templates?: string;
	abi?: number;
}

/** Every shim file for the platform (spec SET-2); `.ps1` files are included only when the policy allows them (WIN-2). */
export function renderShims(
	home: string,
	platform: NodeJS.Platform,
	options: RenderOptions = {},
): ShimFile[] {
	assertSafeHome(home);
	const templates = options.templates ?? templatesDir();
	const abi = options.abi ?? SHIM_ABI;
	const files: ShimFile[] = [];
	for (const name of SELECTORS) {
		files.push({ name, content: posixShim(home, name, templates, abi), mode: 0o755 });
		if (platform === 'win32') {
			files.push({
				name: `${name}.cmd`,
				content: cmdShim(home, name, templates, abi),
				mode: 0o644,
			});
			if (options.powershell !== false) {
				files.push({
					name: `${name}.ps1`,
					content: powershellShim(home, name, templates, abi),
					mode: 0o644,
				});
			}
		}
	}
	return files;
}

/** The ABI a shim or bootstrap file declares, or null when the file is not ours. */
export function shimAbi(content: string): number | null {
	const match = /npm-use launcher abi=(\d+)|LAUNCHER_ABI = (\d+)/.exec(content);
	return match === null ? null : Number(match[1] ?? match[2]);
}

export function shimDir(home: string): string {
	return join(home, SHIM_DIR);
}
