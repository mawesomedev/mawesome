import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { FileSystem } from './fs.ts';
import { expandPatternTarget, isWithin, publishedPredicate } from './fsutil.ts';
import type { Manifest } from './manifest.ts';
import type { TypeResolutionMode, UncheckedSpecifier } from './types.ts';
import { activeTypesVersions } from './typesversions.ts';

/** How an external requirement was expressed — affects how it is resolved. */
export type SpecifierKind = 'module' | 'type-reference';

/** An external bare specifier and the declaration file it was first seen in. */
export interface ExternalSpecifier {
	specifier: string;
	kind: SpecifierKind;
	/** Package-relative path of the `.d.ts` it appears in. */
	firstSeenIn: string;
	/**
	 * `true` when *every* occurrence of this specifier was an inline `import("x")` type — i.e. it
	 * never appeared as an author-written top-level `import`/`export`. A strong leaked-type signal
	 * (tsc inlines `import()` when a dependency's API pulls a type in), though a hand-written inline
	 * import is indistinguishable in the `.d.ts`, so it's not a proof.
	 */
	inlineOnly: boolean;
	/** An explicit `resolution-mode` attribute on the reference; absent → the profile default (ESM). */
	resolutionMode: TypeResolutionMode | undefined;
}

/**
 * Whether the type surface had anything to analyze:
 * - `covered` — at least one declaration entry point resolved and was scanned;
 * - `not-built` — types are declared but none resolve (build output missing);
 * - `ignored-by-exports`: a `types`/`typings` field resolves, but `exports` hides it from TypeScript;
 * - `unreachable` — `.d.ts` ship but no manifest entry exposes them;
 * - `none` — the package legitimately declares and ships no types.
 */
export type TypeCoverage = 'covered' | 'not-built' | 'ignored-by-exports' | 'unreachable' | 'none';

/** The discovered type surface: scanned files and the specifiers they reference. */
export interface SurfaceScan {
	files: string[];
	externals: ExternalSpecifier[];
	unchecked: UncheckedSpecifier[];
	coverage: TypeCoverage;
}

const DTS_RE = /\.d\.[mc]?ts$/;

/**
 * The active conditions for the v1 type surface (NodeNext / ESM, `types` first).
 * `require`, `browser`, `development`, `production` are intentionally excluded —
 * the entry surface is profile-driven, never the union of all branches.
 */
const ACTIVE_CONDITIONS = new Set(['import', 'node', 'default']);

/**
 * Scans the package's released type surface: discovers declaration entry points
 * from the manifest, then follows relative imports between `.d.ts` files,
 * collecting every external specifier reachable on the way.
 */
export function scanTypeSurface(
	fs: FileSystem,
	root: string,
	manifest: Manifest,
	conditions: readonly string[] = [],
	includeFiles?: ReadonlySet<string>,
): SurfaceScan {
	// Keyed by `${kind}:${mode}:${specifier}`; values aggregate `inlineOnly` across every occurrence.
	const externalsByKey = new Map<string, ExternalSpecifier>();
	const unchecked: UncheckedSpecifier[] = [];
	const visited = new Set<string>();
	const published = publishedPredicate(root, includeFiles);
	const active = new Set([...ACTIVE_CONDITIONS, ...conditions]);
	const queue = [...typeEntryPoints(fs, root, manifest, active, published)];

	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const rel = relative(root, file);

		for (const ref of specifiersIn(fs, file)) {
			if (ref.kind === 'module' && isRelative(ref.specifier)) {
				const target = resolveRelativeDts(fs, file, ref.specifier, root);
				// Only follow into a file the package actually publishes — a consumer can't reach the rest.
				if (target !== undefined && !visited.has(target) && published(target)) {
					queue.push(target);
				}
				continue;
			}
			if (ref.dynamic) {
				unchecked.push({ specifier: ref.specifier, reason: 'dynamic specifier', firstSeenIn: rel });
				continue;
			}
			/* The mode is part of the key: each requested resolution mode is a distinct requirement.
			 * An absent attribute collapses with an explicit `import` — both resolve in the profile default (ESM). */
			const dedupeKey = `${ref.kind}:${ref.resolutionMode ?? 'import'}:${ref.specifier}`;
			const existing = externalsByKey.get(dedupeKey);
			if (existing === undefined) {
				externalsByKey.set(dedupeKey, {
					specifier: ref.specifier,
					kind: ref.kind,
					firstSeenIn: rel,
					inlineOnly: ref.inlineImport,
					resolutionMode: ref.resolutionMode,
				});
			} else if (!ref.inlineImport) {
				// A later author-written occurrence means it's no longer inline-only (a direct reference).
				existing.inlineOnly = false;
			}
		}
	}

	const coverage = typeCoverage(fs, root, manifest, visited.size > 0, published);
	const externals = [...externalsByKey.values()];
	return { files: [...visited].map((f) => relative(root, f)), externals, unchecked, coverage };
}

/** Classifies why a type surface was empty, so "clean" is never confused with "nothing to audit". */
function typeCoverage(
	fs: FileSystem,
	root: string,
	manifest: Manifest,
	scannedAny: boolean,
	published: (abs: string) => boolean,
): TypeCoverage {
	if (scannedAny) {
		return 'covered';
	}
	// TS skips `types`/`typings` when `exports` exists, so a built legacy entry is hidden, not missing.
	if (
		manifest.exports !== undefined &&
		!exportsDeclaresTypes(manifest.exports) &&
		[manifest.types, manifest.typings].some(
			(target) => legacyDeclarationPath(fs, root, target, published) !== undefined,
		)
	) {
		return 'ignored-by-exports';
	}
	// A declared types entry that did not resolve means the build output is absent.
	if (manifestDeclaresTypes(manifest)) {
		return 'not-built';
	}
	// Published declarations exist on disk but nothing in the manifest exposes them.
	if (allDeclarationFiles(fs, root, published).length > 0) {
		return 'unreachable';
	}
	return 'none';
}

/** `true` when the manifest explicitly declares type declarations (field or `types` condition). */
export function manifestDeclaresTypes(manifest: Manifest): boolean {
	if (manifest.types !== undefined || manifest.typings !== undefined) {
		return true;
	}
	if (manifest.typesVersions !== undefined) {
		return true;
	}
	return manifest.exports !== undefined && exportsDeclaresTypes(manifest.exports);
}

/** `true` if any conditional `exports` branch carries a `types` condition. */
function exportsDeclaresTypes(node: unknown): boolean {
	if (node === null || typeof node !== 'object') {
		return false;
	}
	if (Array.isArray(node)) {
		return node.some(exportsDeclaresTypes);
	}
	const record = node as Record<string, unknown>;
	if ('types' in record) {
		return true;
	}
	return Object.values(record).some(exportsDeclaresTypes);
}

/** Discovers absolute paths of the declaration entry points from the manifest. */
function typeEntryPoints(
	fs: FileSystem,
	root: string,
	manifest: Manifest,
	active: ReadonlySet<string>,
	published: (abs: string) => boolean,
): string[] {
	const found = new Set<string>();
	const addTarget = (target: string | undefined): void => {
		const dts = target === undefined ? undefined : toDeclarationPath(target);
		if (dts !== undefined) {
			const abs = resolve(root, dts);
			if (fs.isFile(abs) && published(abs)) {
				found.add(abs);
			}
		}
	};

	if (manifest.exports !== undefined) {
		// `exports` encapsulates the package: only its (profile-selected) targets are the
		// surface. Legacy `types`/`typings` and `typesVersions` are ignored when `exports`
		// is present (TS does extension substitution from the JS target instead).
		for (const target of exportsTypeTargets(manifest.exports, active)) {
			expandPatternTarget(fs, root, target).forEach(addTarget);
		}
		return [...found];
	}

	// No `exports`: `typesVersions` (current TS) may redirect where declarations live.
	const tv = activeTypesVersions(manifest.typesVersions, ts.version);
	if (tv?.catchAll) {
		// A `"*"` catch-all governs every subpath, so the active mapping's targets are the
		// whole reachable surface — scan exactly those (excluding sibling/older-TS dirs that
		// whole-tarball scanning would otherwise over-include).
		for (const target of tv.targets) {
			expandPatternTarget(fs, root, target).forEach(addTarget);
		}
		return [...found];
	}

	// Otherwise consumers can deep-import any published declaration file: the reachable set
	// is every `.d.ts` in the tarball, plus the legacy entry points and any `typesVersions`
	// targets (additive, so a non-catch-all mapping never causes under-scanning).
	addTarget(manifest.types);
	addTarget(manifest.typings);
	addTarget(manifest.module);
	addTarget(manifest.main);
	for (const target of tv?.targets ?? []) {
		expandPatternTarget(fs, root, target).forEach(addTarget);
	}
	for (const file of allDeclarationFiles(fs, root, published)) {
		found.add(file);
	}
	return [...found];
}

/** Selects the type-surface target(s) from an `exports` field for the v1 profile. */
function exportsTypeTargets(exportsField: unknown, active: ReadonlySet<string>): string[] {
	if (isSubpathMap(exportsField)) {
		const targets: string[] = [];
		for (const value of Object.values(exportsField)) {
			// Pattern subpath keys (`./*`) are included; their target is expanded later.
			const target = selectConditionTarget(value, active);
			if (target !== undefined) {
				targets.push(target);
			}
		}
		return targets;
	}
	const target = selectConditionTarget(exportsField, active);
	return target === undefined ? [] : [target];
}

/** `true` when an `exports` value maps subpaths (`"."`, `"./x"`) rather than conditions. */
function isSubpathMap(node: unknown): node is Record<string, unknown> {
	return (
		node !== null &&
		typeof node === 'object' &&
		!Array.isArray(node) &&
		Object.keys(node).some((key) => key.startsWith('.'))
	);
}

/** Resolves a conditional `exports` value to one target, `types` first then ESM order. */
function selectConditionTarget(node: unknown, active: ReadonlySet<string>): string | undefined {
	if (typeof node === 'string') {
		return node;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			const target = selectConditionTarget(item, active);
			if (target !== undefined) {
				return target;
			}
		}
		return undefined;
	}
	if (node !== null && typeof node === 'object') {
		const record = node as Record<string, unknown>;
		if ('types' in record) {
			const target = selectConditionTarget(record['types'], active);
			if (target !== undefined) {
				return target;
			}
		}
		for (const [key, value] of Object.entries(record)) {
			if (!key.startsWith('.') && key !== 'types' && active.has(key)) {
				const target = selectConditionTarget(value, active);
				if (target !== undefined) {
					return target;
				}
			}
		}
	}
	return undefined;
}

/** Lists every published declaration file in the tree, excluding bundled deps. */
function allDeclarationFiles(
	fs: FileSystem,
	root: string,
	published: (abs: string) => boolean,
): string[] {
	const out: string[] = [];
	for (const rel of fs.readdirRecursive(root)) {
		if (rel.split(sep).includes('node_modules')) {
			continue;
		}
		if (DTS_RE.test(rel)) {
			const abs = resolve(root, rel);
			if (published(abs)) {
				out.push(abs);
			}
		}
	}
	return out;
}

/**
 * Resolves a legacy `types`/`typings` target the way TypeScript's node10 lookup does.
 * An extensionless target tries `<target>.d.ts`, then `<target>/index.d.ts` for a directory.
 */
function legacyDeclarationPath(
	fs: FileSystem,
	root: string,
	target: string | undefined,
	published: (abs: string) => boolean,
): string | undefined {
	if (target === undefined) {
		return undefined;
	}
	const dts = toDeclarationPath(target);
	const bare = target.replace(/\/+$/, '');
	const candidates = dts === undefined ? [`${bare}.d.ts`, `${bare}/index.d.ts`] : [dts];
	for (const candidate of candidates) {
		const abs = resolve(root, candidate);
		if (isWithin(root, abs) && fs.isFile(abs) && published(abs)) {
			return abs;
		}
	}
	return undefined;
}

/** Maps a runtime or declaration target to its declaration-file form, or `undefined`. */
function toDeclarationPath(target: string): string | undefined {
	if (DTS_RE.test(target)) {
		return target;
	}
	if (target.endsWith('.mjs')) {
		return `${target.slice(0, -'.mjs'.length)}.d.mts`;
	}
	if (target.endsWith('.cjs')) {
		return `${target.slice(0, -'.cjs'.length)}.d.cts`;
	}
	if (target.endsWith('.js')) {
		return `${target.slice(0, -'.js'.length)}.d.ts`;
	}
	return undefined;
}

interface RawSpecifier {
	specifier: string;
	kind: SpecifierKind;
	dynamic: boolean;
	/**
	 * `true` for an inline `import("x")` type node (vs an author-written top-level import). tsc
	 * usually *synthesizes* these when a dependency's API leaks a type, so they're a strong leak
	 * signal — but a hand-written inline import looks identical in the `.d.ts`, so it's not a proof.
	 */
	inlineImport: boolean;
	resolutionMode: TypeResolutionMode | undefined;
}

/** The `resolution-mode` import attribute carried by a reference, when present and valid. */
function attributeResolutionMode(
	attributes: ts.ImportAttributes | undefined,
): TypeResolutionMode | undefined {
	for (const element of attributes?.elements ?? []) {
		if (element.name.text === 'resolution-mode' && ts.isStringLiteral(element.value)) {
			const value = element.value.text;
			if (value === 'import' || value === 'require') {
				return value;
			}
		}
	}
	return undefined;
}

/** Maps a parsed triple-slash `resolution-mode` (`ts.ResolutionMode` — absent when the directive omits it) to the port-level union. */
function directiveResolutionMode(mode: ts.ResolutionMode): TypeResolutionMode | undefined {
	if (mode === ts.ModuleKind.CommonJS) {
		return 'require';
	}
	if (mode === ts.ModuleKind.ESNext) {
		return 'import';
	}
	return undefined;
}

/** Extracts all module specifiers and type references from a declaration file. */
function specifiersIn(fs: FileSystem, file: string): RawSpecifier[] {
	const text = fs.readFile(file);
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: RawSpecifier[] = [];
	const isModule = ts.isExternalModule(sf);

	for (const directive of sf.typeReferenceDirectives) {
		// `/// <reference types="x" />` — a type-only requirement (resolved as a directive).
		out.push({
			specifier: directive.fileName,
			kind: 'type-reference',
			dynamic: false,
			inlineImport: false,
			resolutionMode: directiveResolutionMode(directive.resolutionMode),
		});
	}

	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			// A top-level `import`/`export … from` is author-written, not an inline import type.
			out.push({
				specifier: node.moduleSpecifier.text,
				kind: 'module',
				dynamic: false,
				inlineImport: false,
				resolutionMode: attributeResolutionMode(node.attributes),
			});
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			// `import x = require("y")` is require-shaped — tsc resolves it in CJS mode.
			out.push({
				specifier: node.moduleReference.expression.text,
				kind: 'module',
				dynamic: false,
				inlineImport: false,
				resolutionMode: 'require',
			});
		} else if (ts.isImportTypeNode(node)) {
			const arg = node.argument;
			if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
				/* An inline `import("x").T` type — usually tsc-synthesized when a dependency's API leaks `x`'s type (the leak signal), though indistinguishable from a hand-written one. */
				out.push({
					specifier: arg.literal.text,
					kind: 'module',
					dynamic: false,
					inlineImport: true,
					resolutionMode: attributeResolutionMode(node.attributes),
				});
			} else {
				out.push({
					specifier: arg.getText(sf),
					kind: 'module',
					dynamic: true,
					inlineImport: false,
					resolutionMode: undefined,
				});
			}
		} else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
			// A `declare module "x"` augmentation in an external-module file requires `x`
			// (so its types exist to augment). Ambient script stubs and pattern names
			// (`*.svg`) provide a module instead and are not requirements.
			const name = node.name.text;
			if (isModule && !name.includes('*')) {
				out.push({
					specifier: name,
					kind: 'module',
					dynamic: false,
					inlineImport: false,
					resolutionMode: undefined,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith('.');
}

/** Resolves a relative specifier from a `.d.ts` to the declaration file it targets. */
function resolveRelativeDts(
	fs: FileSystem,
	fromFile: string,
	specifier: string,
	root: string,
): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = DTS_RE.test(specifier)
		? [base]
		: [
				declarationSibling(specifier, base),
				`${base}.d.ts`,
				`${base}.d.mts`,
				`${base}.d.cts`,
				join(base, 'index.d.ts'),
				join(base, 'index.d.mts'),
				join(base, 'index.d.cts'),
			];
	// Stay inside the package root and require an actual file.
	return candidates.find((c) => c !== undefined && isWithin(root, c) && fs.isFile(c));
}

/** For a relative `./x.js`-style import, the adjacent declaration path. */
function declarationSibling(specifier: string, base: string): string | undefined {
	const dts = toDeclarationPath(specifier);
	if (dts === undefined || dts === specifier) {
		return undefined;
	}
	return resolve(dirname(base), dts.slice(dts.lastIndexOf('/') + 1));
}
