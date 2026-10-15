import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { EXIT, NpmUseError } from '../errors.ts';
import { createContext, createInstaller } from '../install/index.ts';
import { findProject } from '../project.ts';
import { parseVersionSpec } from '../spec.ts';
import { mutateFile } from '../state/journal.ts';
import type { CommandContext } from './context.ts';

/** The indentation and newline a JSON file uses, so the rewrite keeps its shape. */
export function detectFormat(text: string): {
	indent: string;
	newline: '\n' | '\r\n';
	trailingNewline: boolean;
} {
	const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
	return {
		indent,
		newline: text.includes('\r\n') ? '\r\n' : '\n',
		trailingNewline: text.endsWith('\n'),
	};
}

/** `devEngines.packageManager` with one npm entry, keeping other managers and the field's shape. */
export function pinnedManifest(
	pkg: Record<string, unknown>,
	version: string,
): Record<string, unknown> {
	const entry = { name: 'npm', version, onFail: 'error' };
	const devEngines =
		typeof pkg['devEngines'] === 'object' && pkg['devEngines'] !== null
			? { ...(pkg['devEngines'] as Record<string, unknown>) }
			: {};
	const existing = devEngines['packageManager'];
	if (Array.isArray(existing)) {
		const others = existing.filter(
			(item) =>
				!(typeof item === 'object' && item !== null && (item as { name?: unknown }).name === 'npm'),
		);
		devEngines['packageManager'] = [...others, entry];
	} else if (
		typeof existing === 'object' &&
		existing !== null &&
		(existing as { name?: unknown }).name !== 'npm'
	) {
		devEngines['packageManager'] = [existing, entry];
	} else {
		devEngines['packageManager'] = entry;
	}
	return { ...pkg, devEngines };
}

function nearestManifestDir(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, 'package.json'))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/** `^<latest npm whose engines accept the active Node>`, asked from the registry. */
async function defaultRange(context: CommandContext): Promise<string> {
	const installer = createInstaller(createContext(context.env, context.dirs.home));
	const candidates = await installer.registry([parseVersionSpec('>=8', 'pin')]);
	const usable = candidates.filter(
		(candidate) =>
			candidate.enginesNode === null ||
			semver.satisfies(process.version, candidate.enginesNode, { includePrerelease: true }),
	);
	const latest = usable.map((candidate) => candidate.version).toSorted(semver.rcompare)[0];
	if (latest === undefined) {
		throw new NpmUseError(
			'M-NOMATCH',
			EXIT.resolution,
			`No npm release supports Node ${process.version}.`,
		);
	}
	return `^${latest}`;
}

export async function pin(
	context: CommandContext,
	range: string | undefined,
	cwd: string = process.cwd(),
): Promise<number> {
	const project = findProject([], cwd, context.env);
	const nearest = nearestManifestDir(cwd);
	if (nearest !== null && nearest !== project.root) {
		throw new NpmUseError(
			'M-NOMATCH',
			EXIT.usage,
			`${nearest} is a workspace of ${project.root}; npm reads devEngines from the root. Run pin from ${project.root} to pin it there.`,
		);
	}
	const file = join(project.root, 'package.json');
	if (!existsSync(file)) {
		throw new NpmUseError('M-NOMATCH', EXIT.usage, `No package.json in ${project.root}.`);
	}
	const version = range ?? (await defaultRange(context));
	try {
		parseVersionSpec(version, 'pin');
	} catch (error) {
		throw new NpmUseError('M-NOMATCH', EXIT.usage, (error as Error).message);
	}
	const text = readFileSync(file, 'utf8');
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new NpmUseError(
			'M-NOMATCH',
			EXIT.usage,
			`${file} is not valid JSON: ${(error as Error).message}`,
		);
	}
	const format = detectFormat(text);
	const body = JSON.stringify(pinnedManifest(pkg, version), null, format.indent).replace(
		/\n/g,
		format.newline,
	);
	const output = `${body}${format.trailingNewline ? format.newline : ''}`;
	if (output !== text) {
		mutateFile(context.dirs.journal, 'project', context.owner, file, Buffer.from(output, 'utf8'));
	}
	context.io.out(
		context.json ? JSON.stringify({ file, version }) : `Pinned npm ${version} in ${file}`,
	);
	return EXIT.ok;
}
