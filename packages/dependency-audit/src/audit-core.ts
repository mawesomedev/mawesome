import { join } from 'node:path';
import { mapLimit } from './concurrency.ts';
import type { FileSystem } from './fs.ts';
import { partitionIgnored } from './ignore.ts';
import { declaredDependencies, readManifest } from './manifest.ts';
import { emit, type ProgressReporter } from './progress.ts';
import { createNormalizer, type Normalizer, typesPackageFor } from './normalize.ts';
import { createTypeResolver, materializeDeps } from './resolve.ts';
import { createRuntimeResolver } from './runtime-resolve.ts';
import { type CallForm, scanRuntimeSurface } from './runtime-surface.ts';
import { scanTypeSurface, type TypeCoverage } from './surface.ts';
import type {
	AcquiredSource,
	AuditResult,
	Finding,
	IgnoreRule,
	Notice,
	RegistryProvider,
	ResolvedDependency,
	Surface,
	UncheckedSpecifier,
	UnresolvedReason,
} from './types.ts';

/** Options for {@link auditPackage}. */
export interface AuditPackageOptions {
	/** Materializes declared deps into `workDir/node_modules`. */
	provider: RegistryProvider;
	/** Where the provider materializes deps (a real temp dir on Node; any path in memory). */
	workDir: string;
	/** Label for the result's `target` field. Defaults to `root`. */
	target?: string;
	/** How the package was acquired (recorded on the result). Defaults to `directory`. */
	source?: AcquiredSource;
	/** Rules that suppress intentional findings (moved to `result.ignored`). */
	ignore?: IgnoreRule[];
	/** Node builtin names (the Node entry injects the live `builtinModules`; default hardcoded). */
	builtins?: readonly string[];
	/** Extra resolution conditions to activate (e.g. `["browser"]`), added to the defaults. */
	conditions?: readonly string[];
	/** Cap on concurrent dep materializations (default {@link DEFAULT_MATERIALIZE_CONCURRENCY}). */
	materializeConcurrency?: number;
	/**
	 * Restricts both surface scans to these package-relative POSIX paths — the package's publish
	 * set. When set, a file outside it (a test, an example, a build script `npm publish` would
	 * exclude) is never scanned, so a directory audit matches a packed `.tgz`. Absent = scan every
	 * file on disk (the Node entry computes this for directory targets; the browser host omits it).
	 */
	includeFiles?: ReadonlySet<string>;
	/** Optional progress sink, notified as deps materialize and surfaces are scanned. */
	progress?: ProgressReporter;
}

/** A specifier seen on a surface — the shared shape findings are built from. */
interface Seen {
	specifier: string;
	firstSeenIn: string;
}

/**
 * Audits an already-extracted package `root`, reading entirely through the `fs` port —
 * no `node:fs`, acquisition, or temp management — so it runs identically on Node and in
 * the browser. The Node entry (`audit`) wraps this with acquisition + a temp dir; a
 * browser host wraps it with an in-memory filesystem and a fetch-based provider.
 */
export async function auditPackage(
	fs: FileSystem,
	root: string,
	options: AuditPackageOptions,
): Promise<AuditResult> {
	const { provider, workDir, progress } = options;
	const target = options.target ?? root;
	const manifest = readManifest(fs, root);
	const deps = declaredDependencies(manifest);
	const declared = new Set(deps.map((dep) => dep.name));
	emit(progress, { type: 'materialize:start', target, total: deps.length });
	const resolved = await materializeDeps(
		deps,
		provider,
		workDir,
		(done, total) => emit(progress, { type: 'materialize:progress', target, done, total }),
		options.materializeConcurrency,
	);
	// Only deps that actually materialized can satisfy a reference.
	const materialized = new Set(
		resolved.filter((dep) => dep.version !== undefined).map((dep) => dep.name),
	);
	const conditions = options.conditions ?? [];
	const typeResolver = createTypeResolver(fs, workDir, conditions);
	const runtimeResolver = createRuntimeResolver(fs, workDir, conditions);
	const normalizeSpecifier = createNormalizer(options.builtins);

	const findings: Finding[] = [];
	// Findings born from a `/// <reference types … />` directive, tracked by identity — a same-named module import stays refinable.
	const directiveFindings = new Set<Finding>();
	const unchecked: UncheckedSpecifier[] = [];
	const isSelf = (name: string): boolean => manifest.name !== undefined && name === manifest.name;

	emit(progress, { type: 'scan:start', target, surface: 'types' });
	const typeSurface = scanTypeSurface(fs, root, manifest, conditions, options.includeFiles);
	unchecked.push(...typeSurface.unchecked);
	const notices = typeCoverageNotices(typeSurface.coverage);
	for (const external of typeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		if (normalized === null || isSelf(normalized.packageName)) {
			continue;
		}
		if (external.kind === 'type-reference') {
			if (!typeResolver.resolvesTypeReference(external.specifier, external.resolutionMode)) {
				const directiveFinding = typeFinding(external, normalized.packageName, declared);
				directiveFindings.add(directiveFinding);
				findings.push(directiveFinding);
			}
			continue;
		}
		if (normalized.isBuiltin) {
			// A builtin on the type surface needs @types/node; ambient `declare module`s
			// are not found by module resolution, so test materialization, not resolution.
			if (!materialized.has('@types/node')) {
				findings.push(builtinTypeFinding(external, normalized.packageName));
			}
			continue;
		}
		if (!typeResolver.resolvesToDeclaration(external.specifier, external.resolutionMode)) {
			findings.push(typeFinding(external, normalized.packageName, declared));
		}
	}

	emit(progress, { type: 'scan:start', target, surface: 'runtime' });
	const runtimeSurface = scanRuntimeSurface(fs, root, manifest, conditions, options.includeFiles);
	unchecked.push(...runtimeSurface.unchecked);
	for (const external of runtimeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		// Node builtins need no declaration on the runtime surface.
		if (normalized === null || normalized.isBuiltin || isSelf(normalized.packageName)) {
			continue;
		}
		const resolution = runtimeResolver.resolvesRuntime(external.specifier, external.form);
		if (!resolution.resolved) {
			findings.push(
				runtimeFinding(
					external,
					normalized.packageName,
					declared,
					external.form,
					resolution.reason,
				),
			);
		}
	}

	/*
	 * Packages referenced *only* via inline `import("x")` types (never an author-written top-level
	 * import or `/// <reference>`) — a strong leaked-type signal (tsc inlines `import()` when a
	 * dependency's API pulls a type in). Used to gate leak attribution so a genuine direct import
	 * isn't called a leak.
	 */
	const inlineLeaked = new Set<string>();
	const directlyReferenced = new Set<string>();
	for (const external of typeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		if (normalized === null || isSelf(normalized.packageName)) {
			continue;
		}
		(external.inlineOnly ? inlineLeaked : directlyReferenced).add(normalized.packageName);
	}
	for (const name of directlyReferenced) {
		inlineLeaked.delete(name);
	}

	// Attribute leaked types: an undeclared type also exposed by a declared dependency's own API.
	attributeTypeLeaks(
		fs,
		workDir,
		conditions,
		findings,
		materialized,
		normalizeSpecifier,
		manifest.name,
		inlineLeaked,
	);

	/*
	 * Suppress intentional findings first, then refine only the survivors, then re-check them.
	 * Refining before this would let a `{ kind: "missing-types" }` rule silently stop matching a
	 * finding reclassified to `types-unavailable` — turning a previously-ignored gap into a failure.
	 * The second pass catches a `{ kind: "types-unavailable" }` rule against the now-refined kind.
	 */
	const rules = options.ignore ?? [];
	const context = { name: manifest.name, target };
	// Rules that suppressed something, across both passes — the caller judges staleness run-wide.
	const usedRules = new Set<IgnoreRule>();
	const suppressed = partitionIgnored(findings, rules, context, usedRules);
	await refineMissingTypes(suppressed.findings, provider, declared, resolved, (name) =>
		typeResolver.resolvesToDeclaration(name),
	);
	await refineUndeclaredAdvice(
		suppressed.findings,
		provider,
		normalizeSpecifier,
		directiveFindings,
	);
	const partitioned = partitionIgnored(suppressed.findings, rules, context, usedRules);
	return {
		target,
		source: options.source ?? { kind: 'directory' },
		packageName: manifest.name,
		packageVersion: manifest.version,
		ok: partitioned.findings.length === 0,
		findings: partitioned.findings,
		ignored: [...suppressed.ignored, ...partitioned.ignored],
		usedIgnoreRules: rules.filter((rule) => usedRules.has(rule)),
		unchecked,
		notices,
		resolvedDeps: resolved,
	};
}

/** Maps a type-surface coverage verdict to a user-facing notice (none when fully covered). */
function typeCoverageNotices(coverage: TypeCoverage): Notice[] {
	if (coverage === 'not-built') {
		return [
			{
				kind: 'types-not-built',
				surface: 'types',
				message:
					'declares type declarations, but none resolve from the package root — the build output looks missing (build the package before auditing, fix the declared types path, or include it in the publish set)',
			},
		];
	}
	if (coverage === 'ignored-by-exports') {
		return [
			{
				kind: 'types-ignored-by-exports',
				surface: 'types',
				message:
					'declares a "types"/"typings" field, but "exports" is present, so TypeScript ignores it and resolves no types; add a "types" condition to "exports" (or ship a .d.ts next to each exported .js)',
			},
		];
	}
	if (coverage === 'unreachable') {
		return [
			{
				kind: 'types-unreachable',
				surface: 'types',
				message:
					'ships .d.ts files, but no "types" field or "exports" types condition exposes them — consumers cannot resolve its types (a likely packaging gap)',
			},
		];
	}
	return [];
}

/** Cap on concurrent registry existence probes, to bound load on the shared registry. */
const TYPES_PROBE_CONCURRENCY = 8;

type Existence = 'exists' | 'absent' | 'unknown';

/**
 * Refines `missing-types` findings using the provider's optional registry probe.
 * When the `@types/*` companion does not exist, the gap is not fixable by declaring a dependency, so the finding is reclassified `types-unavailable` with honest advice.
 * An `exists`/`unknown` result (or a provider without the capability — e.g. the browser default) leaves the conservative `missing-types` finding unchanged.
 */
async function refineMissingTypes(
	findings: Finding[],
	provider: RegistryProvider,
	declared: Set<string>,
	resolved: ResolvedDependency[],
	resolvesBareTypes: (name: string) => boolean,
): Promise<void> {
	if (provider.packageExists === undefined) {
		return;
	}
	// Bind to preserve the receiver — a class-backed custom provider may use `this`.
	const probeTypes = provider.packageExists.bind(provider);
	const probeTypedVersion = provider.latestTypedVersion?.bind(provider);
	const versionOf = new Map(resolved.map((dep) => [dep.name, dep.version]));
	/*
	 * Refine only packages that ship *no* types of their own — the `@types/*` / version-bump /
	 * unavailable advice is about a package with no types at all. A `missing-types` for a *subpath*
	 * of a package whose bare entry does resolve to types is a subpath gap, not that, so it keeps
	 * its original suggestion. The bare-entry resolution catches implicit `index.d.ts` types too,
	 * which a manifest-field check (`types`/`exports`) would miss.
	 */
	const names = [
		...new Set(
			findings
				.filter(
					(f) =>
						f.kind === 'missing-types' &&
						!declared.has(typesPackageFor(f.packageName)) &&
						!resolvesBareTypes(f.packageName),
				)
				.map((f) => f.packageName),
		),
	];
	if (names.length === 0) {
		return;
	}
	const availability = new Map<string, Existence>();
	await mapLimit(names, TYPES_PROBE_CONCURRENCY, async (name) => {
		availability.set(name, await probeTypes(typesPackageFor(name)));
	});
	// For packages with no `@types/*`, see whether a published version ships its own types.
	const typedVersion = new Map<string, string | undefined>();
	if (probeTypedVersion !== undefined) {
		const absent = names.filter((name) => availability.get(name) === 'absent');
		await mapLimit(absent, TYPES_PROBE_CONCURRENCY, async (name) => {
			const current = versionOf.get(name);
			if (current !== undefined) {
				typedVersion.set(name, await probeTypedVersion(name, current));
			}
		});
	}
	for (const candidate of findings) {
		if (
			candidate.kind !== 'missing-types' ||
			availability.get(candidate.packageName) !== 'absent'
		) {
			continue;
		}
		const upgrade = typedVersion.get(candidate.packageName);
		if (upgrade !== undefined) {
			// Fixable by depending on the version that ships types — stays `missing-types`.
			candidate.suggestion = typedVersionSuggestion(
				candidate.packageName,
				upgrade,
				candidate.specifier,
			);
		} else {
			candidate.kind = 'types-unavailable';
			candidate.suggestion = typesUnavailableSuggestion(candidate.packageName);
		}
	}
}

/**
 * Refines `undeclared` type-surface suggestions using the provider's optional registry probe.
 * When no `@types/*` companion exists, the "(or `@types/x` …)" alternative is dropped — pointing at a nonexistent package is noise, and such a package often ships its own types (e.g. a leaked typed dependency).
 * An `exists`/`unknown` result (or a provider without the capability) keeps the conservative hedged advice; the finding's kind is never changed.
 */
async function refineUndeclaredAdvice(
	findings: Finding[],
	provider: RegistryProvider,
	normalizeSpecifier: Normalizer,
	directiveFindings: ReadonlySet<Finding>,
): Promise<void> {
	if (provider.packageExists === undefined) {
		return;
	}
	// Bind to preserve the receiver — a class-backed custom provider may use `this`.
	const probeTypes = provider.packageExists.bind(provider);
	/*
	 * A Node builtin's finding already points at "@types/node" (which exists), and an `@types/*`
	 * name has no further companion — neither carries an alternative to drop.
	 * A `/// <reference types="x" />` directive resolves *through* `@types/*` (e.g. `types="node"` → `@types/node`), so its alternative is the fix itself, never noise.
	 * The exclusion is by finding identity, so a same-named module import is still refined.
	 */
	const candidates = findings.filter(
		(f) =>
			f.surface === 'types' &&
			f.kind === 'undeclared' &&
			!f.packageName.startsWith('@types/') &&
			!directiveFindings.has(f) &&
			normalizeSpecifier(f.specifier)?.isBuiltin !== true,
	);
	const names = [...new Set(candidates.map((f) => f.packageName))];
	if (names.length === 0) {
		return;
	}
	const availability = new Map<string, Existence>();
	await mapLimit(names, TYPES_PROBE_CONCURRENCY, async (name) => {
		availability.set(name, await probeTypes(typesPackageFor(name)));
	});
	for (const candidate of candidates) {
		if (availability.get(candidate.packageName) !== 'absent') {
			continue;
		}
		// Rebuild through the original suggestion builder so the wording stays in one place.
		candidate.suggestion =
			candidate.leakedVia !== undefined && candidate.leakedVia.length > 0
				? leakSuggestion(candidate.packageName, candidate.leakedVia, false)
				: declareHint(candidate.packageName, typesPackageFor(candidate.packageName), false);
	}
}

function typesUnavailableSuggestion(packageName: string): string {
	const typesPackage = typesPackageFor(packageName);
	return `"${packageName}" provides no resolvable types and no "${typesPackage}" exists on the registry — not fixable by declaring a dependency; ship types upstream, or add a local ambient \`declare module "${packageName}"\``;
}

function typedVersionSuggestion(packageName: string, version: string, specifier: string): string {
	const typesPackage = typesPackageFor(packageName);
	const base = `"${packageName}" provides no types at the resolved version and no "${typesPackage}" exists, but "${packageName}@${version}" ships its own types — depend on that version`;
	return isSubpathSpecifier(specifier, packageName)
		? `${base} (if it does not declare the "${specifier}" subpath, add a local ambient \`declare module "${specifier}"\`)`
		: base;
}

/**
 * Attributes a likely leaked type: an `undeclared` type-surface reference whose package is *also*
 * exposed by a declared dependency's own public API — a strong signal it entered the audited
 * package's `.d.ts` through that dependency rather than a direct import (the `.d.ts` portability
 * trap). For each such finding it scans every materialized declared dependency's type surface; a
 * dependency whose surface references the same package name is recorded in `leakedVia`, and the
 * suggestion is reworded to point at the producer. Reuses {@link scanTypeSurface} (no type-checker),
 * so it stays runtime-agnostic. Runs only when there are candidate findings.
 *
 * Candidates are restricted to `inlineLeaked` — packages that appeared *only* as inline `import()`
 * types — so a package the audited code imports directly (an author-written import) is never
 * mislabeled a leak.
 */
function attributeTypeLeaks(
	fs: FileSystem,
	workDir: string,
	conditions: readonly string[],
	findings: Finding[],
	materialized: ReadonlySet<string>,
	normalizeSpecifier: Normalizer,
	selfName: string | undefined,
	inlineLeaked: ReadonlySet<string>,
): void {
	// Candidates: undeclared type-surface findings for a real package that only leaked in inline
	// (a Node builtin is never a leak; a directly-imported package is a direct use, not a leak).
	const candidates = findings.filter(
		(f) =>
			f.surface === 'types' &&
			f.kind === 'undeclared' &&
			inlineLeaked.has(f.packageName) &&
			normalizeSpecifier(f.specifier)?.isBuiltin !== true,
	);
	if (candidates.length === 0) {
		return;
	}
	const leaked = new Set(candidates.map((f) => f.packageName));
	const nodeModules = join(workDir, 'node_modules');
	// Leaked package name → declared deps that expose it (a Set dedups a dep that references it twice).
	const producersOf = new Map<string, Set<string>>();
	for (const depName of materialized) {
		// A package can't leak through itself (it may declare itself, so it can be materialized).
		if (depName === selfName) {
			continue;
		}
		const depRoot = join(nodeModules, depName);
		if (!fs.isDirectory(depRoot)) {
			continue;
		}
		// Intersect the dep's own externals with the leaked set as we scan — no nested per-spec loop.
		for (const external of scanTypeSurface(fs, depRoot, readManifest(fs, depRoot), conditions)
			.externals) {
			const name = normalizeSpecifier(external.specifier)?.packageName;
			if (name !== undefined && leaked.has(name)) {
				(producersOf.get(name) ?? producersOf.set(name, new Set()).get(name)!).add(depName);
			}
		}
	}
	for (const candidate of candidates) {
		const producers = producersOf.get(candidate.packageName);
		if (producers !== undefined && producers.size > 0) {
			candidate.leakedVia = [...producers];
			candidate.suggestion = leakSuggestion(candidate.packageName, candidate.leakedVia);
		}
	}
}

function leakSuggestion(
	packageName: string,
	producers: string[],
	companionMayExist = true,
): string {
	const many = producers.length > 1;
	const via = producers.map((p) => `"${p}"`).join(', ');
	// Match `declareHint`: no `@types/*` alternative for an `@types/*` name or a companion the registry says is absent.
	const workaround =
		packageName.startsWith('@types/') || !companionMayExist
			? `declare "${packageName}" yourself`
			: `declare "${packageName}" (or "${typesPackageFor(packageName)}" if it ships no types) yourself`;
	return `"${packageName}" is also exposed by declared ${many ? 'dependencies' : 'dependency'} ${via} — if you don't import it directly, it likely leaks into your types through ${many ? 'their' : 'its'} public API, and the durable fix is in the producer (bundle "${packageName}"'s types or stop exposing it); otherwise ${workaround}`;
}

function builtinTypeFinding(seen: Seen, packageName: string): Finding {
	return {
		specifier: seen.specifier,
		packageName,
		surface: 'types',
		kind: 'undeclared',
		firstSeenIn: seen.firstSeenIn,
		suggestion: `declare "@types/node" (the declaration references the Node builtin "${packageName}")`,
	};
}

function typeFinding(seen: Seen, packageName: string, declared: Set<string>): Finding {
	const typesPackage = typesPackageFor(packageName);
	const known = declared.has(packageName) || declared.has(typesPackage);
	if (!known) {
		return finding(
			seen,
			packageName,
			'types',
			'undeclared',
			declareHint(packageName, typesPackage),
		);
	}
	return finding(
		seen,
		packageName,
		'types',
		'missing-types',
		missingTypesSuggestion(packageName, seen.specifier, typesPackage),
	);
}

/** `true` when the specifier reaches a subpath of its package rather than the bare package entry. */
function isSubpathSpecifier(specifier: string, packageName: string): boolean {
	return specifier !== packageName;
}

/**
 * The `missing-types` remediation hint.
 * A *subpath* import gets a caveat, since the `@types/*` companion (or a typed version) may not declare that exact subpath even when it exists.
 * The fallback fix is then a local ambient `declare module`.
 */
function missingTypesSuggestion(
	packageName: string,
	specifier: string,
	typesPackage: string,
): string {
	if (isSubpathSpecifier(specifier, packageName)) {
		return `"${packageName}" is declared but provides no resolvable declarations for the subpath "${specifier}"; add "${typesPackage}" or a version that ships types — if it does not declare this subpath, add a local ambient \`declare module "${specifier}"\``;
	}
	return `"${packageName}" is declared but provides no resolvable declarations for "${specifier}"; add "${typesPackage}" or a version that ships types`;
}

function runtimeFinding(
	seen: Seen,
	packageName: string,
	declared: Set<string>,
	form: CallForm,
	reason: UnresolvedReason | undefined,
): Finding {
	if (!declared.has(packageName)) {
		return finding(
			seen,
			packageName,
			'runtime',
			'undeclared',
			`declare "${packageName}" (it is imported at runtime but not a declared dependency)`,
		);
	}
	const result = finding(
		seen,
		packageName,
		'runtime',
		'unresolved',
		unresolvedSuggestion(seen.specifier, packageName, form, reason),
	);
	if (reason !== undefined) {
		result.reason = reason;
	}
	return result;
}

/** The remediation hint for an `unresolved` finding, named by its classified cause. */
function unresolvedSuggestion(
	specifier: string,
	packageName: string,
	form: CallForm,
	reason: UnresolvedReason | undefined,
): string {
	switch (reason) {
		case 'condition-mismatch': {
			const used = form === 'require' ? 'require (CJS)' : 'import (ESM)';
			const works = form === 'require' ? 'import (ESM)' : 'require (CJS)';
			const missing = form === 'require' ? 'require' : 'import';
			return `"${specifier}" resolves for ${works} but was loaded via ${used} — "${packageName}" exposes no "${missing}" export condition (ESM/CJS mismatch)`;
		}
		case 'subpath-not-exported':
			return `"${specifier}" is not exported by "${packageName}" (its "exports" map does not expose this subpath)`;
		case 'file-missing':
			return `"${specifier}" maps through "${packageName}" to a target file that is missing`;
		default:
			return `"${specifier}" does not resolve through declared "${packageName}" (subpath not exported, or the target file is missing)`;
	}
}

function declareHint(packageName: string, typesPackage: string, companionMayExist = true): string {
	return `declare "${packageName}"${
		packageName.startsWith('@types/') || !companionMayExist
			? ''
			: ` (or "${typesPackage}" if it ships no types)`
	}`;
}

function finding(
	seen: Seen,
	packageName: string,
	surface: Surface,
	kind: Finding['kind'],
	suggestion: string,
): Finding {
	return {
		specifier: seen.specifier,
		packageName,
		surface,
		kind,
		firstSeenIn: seen.firstSeenIn,
		suggestion,
	};
}
