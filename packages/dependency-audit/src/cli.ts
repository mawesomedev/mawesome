#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { SkippedTargetError } from './acquire.ts';
import { audit } from './audit.ts';
import { color, colorErr } from './color.ts';
import { mapLimit } from './concurrency.ts';
import { correlateRootCauses, isCollapsed, resultFails } from './correlate.ts';
import { expandGlobTargets } from './glob-targets.ts';
import { parseIgnoreRules } from './ignore.ts';
import { createTtyReporter } from './progress-tty.ts';
import type { AuditResult, Finding, IgnoreRule } from './types.ts';

/** Max targets audited in parallel; each target itself fans out to its own deps. */
const TARGET_CONCURRENCY = 6;

/**
 * Per-target result: an audit, a hard error (exit 2), or a skip (a non-package path, e.g. a
 * stray glob match — neutral, never escalates the exit code).
 */
type Outcome =
	| { target: string; result: AuditResult }
	| { target: string; error: string }
	| { target: string; skipped: string };

const VERSION = readSelfVersion();

const USAGE = `dependency-audit v${VERSION} — verify a package's released imports are all declared

Usage:
  dependency-audit [options] <target...>

A target is a package directory, a .tgz path, a published spec (name@version,
name@tag, @scope/name), or an http(s) tarball URL. A glob (e.g. ./packages/*) is
expanded internally, so it works even on shells that don't expand globs (Windows).

Options:
  --ignore <value>  Suppress findings whose package OR specifier equals <value>
                    (repeatable). Suppressed findings are still listed.
  --config <path>   Load ignore rules from a JSON config (default:
                    ./dependency-audit.config.json if present).
  --fail-unused-ignores  Fail (exit 1) when an ignore rule matched nothing in
                    this run. Stale rules are otherwise only warned about.
  --condition <name>  Activate an extra resolution condition (e.g. browser) for
                    entry discovery and resolution (repeatable).
  --concurrency <n>  Cap how many targets — and how many deps per target —
                    materialize at once (default: 6 targets x 12 deps). Lower it
                    to ease load on a large batch; --concurrency 1 runs fully
                    serially. Also via DEPENDENCY_AUDIT_CONCURRENCY.
  --require-types   Treat a missing/hidden/unreachable type surface (a coverage notice)
                    as a failure rather than just a notice.
  --collapse-root-cause  In a multi-target run, don't fail on a finding whose
                    root cause is another audited target (its types aren't
                    built/reachable) — fix that producer instead. Such findings
                    are still listed, muted.
  --json            Emit machine-readable JSON: a { tool, version, results }
                    envelope; results has one entry per target (an AuditResult,
                    or { target, error } for a failed audit).
  --no-progress     Suppress the stderr version banner and progress spinner
                    even on a terminal (also honored via the NO_PROGRESS env var).
  -v, --version     Print the version.
  -h, --help        Show this help.

Exit codes: 0 = clean, 1 = findings, 2 = error.`;

const DEFAULT_CONFIG = 'dependency-audit.config.json';

/** Reads this package's own version from its manifest (next to the built bin). */
function readSelfVersion(): string {
	try {
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version?: string };
		return manifest.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			ignore: { type: 'string', multiple: true },
			config: { type: 'string' },
			'fail-unused-ignores': { type: 'boolean', default: false },
			condition: { type: 'string', multiple: true },
			concurrency: { type: 'string' },
			'require-types': { type: 'boolean', default: false },
			'collapse-root-cause': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
			'no-progress': { type: 'boolean', default: false },
			version: { type: 'boolean', short: 'v', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});

	if (values.version) {
		console.log(VERSION);
		return 0;
	}
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (positionals.length === 0) {
		console.error(USAGE);
		return 2;
	}

	// Expand glob targets ourselves, so `./packages/*` works even on shells that don't (Windows).
	const targets = expandGlobTargets(positionals);

	const ignoreSources = [...loadConfigRules(values.config), ...cliIgnoreRules(values.ignore ?? [])];
	const ignore = ignoreSources.flatMap((source) => source.rules);
	const conditions = values.condition ?? [];

	/* One `--concurrency` knob, flag over env, caps both fan-out levels: how many targets run at
	 * once and how many deps each target materializes. Left unset it keeps the defaults (6 targets,
	 * 12 deps) — overriding only the target count would still let each target fan out 12-wide, so
	 * `--concurrency 1` would not actually serialize. `retries` is env-only (no everyday flag). */
	const concurrency = intOption(
		values.concurrency ?? process.env['DEPENDENCY_AUDIT_CONCURRENCY'],
		'--concurrency / DEPENDENCY_AUDIT_CONCURRENCY',
		1,
	);
	const targetConcurrency = concurrency ?? TARGET_CONCURRENCY;
	const retries = intOption(process.env['DEPENDENCY_AUDIT_RETRIES'], 'DEPENDENCY_AUDIT_RETRIES', 0);

	/* A live stderr spinner (no-op unless stderr is an interactive TTY) so a long audit never looks hung.
	 * It only touches stderr, so `--json` / `> file` stdout stays clean.
	 * The cleanup handles are exposed module-wide so `finish()` and the background-error handler can keep the line tidy. */
	const progress = createTtyReporter({
		total: targets.length,
		enabled: !(values['no-progress'] ?? false),
	});
	clearProgress = progress.clear;
	stopProgress = progress.stop;

	/* Identify the tool on stderr before work starts, so an interactive run is self-describing.
	 * Gated exactly like the spinner (TTY, not disabled) so stdout — and a captured log or redirect — stays clean.
	 * Dim is keyed to stderr (not the `color` helpers' stdout check) so it matches the spinner when stdout is redirected but stderr is the terminal. */
	if (progress.enabled) {
		const banner = styleText('dim', `dependency-audit v${VERSION}`, { stream: process.stderr });
		process.stderr.write(`${banner}\n`);
	}

	/* Each audit is self-contained (its own temp dirs), so targets run concurrently —
	 * but bounded, and each isolated, so one target's failure reports as an error for
	 * that target instead of discarding every other target's result. */
	const outcomes = await mapLimit(targets, targetConcurrency, async (target): Promise<Outcome> => {
		try {
			return {
				target,
				result: await audit(target, {
					ignore,
					conditions,
					progress: progress.reporter,
					// Only override the per-target materialize cap when `--concurrency` is set,
					// so the default stays 12 rather than collapsing to the target count.
					...(concurrency !== undefined ? { materializeConcurrency: concurrency } : {}),
					...(retries !== undefined ? { retries } : {}),
				}),
			};
		} catch (error) {
			if (error instanceof SkippedTargetError) {
				return { target, skipped: error.reason };
			}
			return { target, error: errorMessage(error) };
		}
	});
	// Erase the spinner before any stdout result write so the two streams never interleave.
	progress.stop();

	// Annotate findings whose root cause is another target in this run (a producer's coverage gap).
	correlateRootCauses(outcomes.flatMap((outcome) => ('result' in outcome ? [outcome.result] : [])));
	// `--collapse-root-cause`: such correlated findings no longer fail the run (fix the producer).
	const collapse = values['collapse-root-cause'] ?? false;

	/* Stale-ignore detection, judged across the whole run. Under `--fail-unused-ignores` a stale
	 * rule fails the run, so it is reported as an `error` (red); otherwise a non-fatal `warning`
	 * (yellow). The lines print at the very end of the run — after the recap and summary in a normal
	 * run (on stdout), or on stderr under `--json` so the JSON stdout payload stays clean. */
	const unusedIgnores = unusedIgnoreSources(ignoreSources, outcomes);
	const failUnusedIgnores = values['fail-unused-ignores'] ?? false;

	if (values.json) {
		/* A `{ tool, version, results }` envelope so a saved audit artifact records the
		 * producing version — the resolution behavior evolves, so output is only reproducible
		 * when its version is known. `results` is the per-target array (the prior top-level shape). */
		const payload = {
			tool: 'dependency-audit',
			version: VERSION,
			results: outcomes.map(jsonEntry),
		};
		console.log(JSON.stringify(payload, null, 2));
		for (const line of unusedIgnoreLines(unusedIgnores, failUnusedIgnores, colorErr)) {
			console.error(line);
		}
	} else {
		for (const outcome of outcomes) {
			if ('result' in outcome) {
				printResult(outcome.result, collapse);
			} else if ('skipped' in outcome) {
				printSkipped(outcome);
			} else {
				printError(outcome);
			}
		}
		printFindingsRecap(outcomes, collapse);
		printSummary(outcomes, collapse);
		// On stdout, after the summary, so it lands last instead of floating ahead of buffered stdout.
		for (const line of unusedIgnoreLines(unusedIgnores, failUnusedIgnores, color)) {
			console.log(line);
		}
	}

	const anyError = outcomes.some((outcome) => 'error' in outcome);
	const anyFinding = outcomes.some(
		(outcome) => 'result' in outcome && resultFails(outcome.result, collapse),
	);
	// `--require-types` promotes a coverage notice (no/unreachable types) to a failure.
	const anyCoverageGap =
		(values['require-types'] ?? false) &&
		outcomes.some((outcome) => 'result' in outcome && outcome.result.notices.length > 0);
	const anyUnusedIgnore = failUnusedIgnores && unusedIgnores.length > 0;
	// An audit that could not run at all is a harder failure (exit 2) than findings (exit 1);
	// a skip is neutral, so a stray glob match never escalates a findings run into an error run.
	return anyError ? 2 : anyFinding || anyCoverageGap || anyUnusedIgnore ? 1 : 0;
}

/** The JSON shape per target: the result, `{ target, error }`, or `{ target, skipped }`. */
function jsonEntry(
	outcome: Outcome,
): AuditResult | { target: string; error: string } | { target: string; skipped: string } {
	return 'result' in outcome ? outcome.result : outcome;
}

/**
 * Parses an integer option (flag or env), returning `undefined` when unset so a caller can
 * fall back to its own default. Rejects a non-integer or below-`min` value with a clear error.
 */
function intOption(raw: string | undefined, label: string, min: number): number | undefined {
	if (raw === undefined || raw === '') {
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		throw new Error(`Invalid ${label}: "${raw}" — expected an integer >= ${min}.`);
	}
	return value;
}

/**
 * One user-visible ignore entry (a config rule or a `--ignore` flag) and the rule objects it
 * expanded to. Staleness is judged per source: a `--ignore` value expands to a package-OR-specifier
 * rule pair, so it is unused only when *both* of its rules matched nothing.
 */
interface IgnoreSource {
	label: string;
	rules: IgnoreRule[];
}

/** A CLI `--ignore <value>` matches a finding by package OR exact specifier. */
function cliIgnoreRules(values: string[]): IgnoreSource[] {
	return values.map((value) => ({
		label: `--ignore ${value}`,
		rules: [{ package: value }, { specifier: value }],
	}));
}

/** Loads `ignore` rules from a JSON config (explicit `--config`, else the default file). */
function loadConfigRules(configPath: string | undefined): IgnoreSource[] {
	const path = configPath ?? DEFAULT_CONFIG;
	const abs = resolve(path);
	if (configPath === undefined && !existsSync(abs)) {
		return [];
	}
	try {
		// Parse inside the try so a malformed JSON file gets the same `Invalid config` context.
		const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { ignore?: unknown };
		return parseIgnoreRules(parsed.ignore).map((rule) => ({
			label: `${path}: ${JSON.stringify(rule)}`,
			rules: [rule],
		}));
	} catch (error) {
		throw new Error(`Invalid config ${path}: ${error instanceof Error ? error.message : error}`, {
			cause: error,
		});
	}
}

/**
 * The ignore sources whose rules matched nothing across the whole run — stale entries.
 * Suppressed entirely when any target errored: the failed audit might have been the one match,
 * so a warning there would push someone to delete a rule that is still needed.
 */
function unusedIgnoreSources(sources: IgnoreSource[], outcomes: Outcome[]): IgnoreSource[] {
	if (sources.length === 0 || outcomes.some((outcome) => 'error' in outcome)) {
		return [];
	}
	const used = new Set(
		outcomes.flatMap((outcome) => ('result' in outcome ? outcome.result.usedIgnoreRules : [])),
	);
	return sources.filter((source) => source.rules.every((rule) => !used.has(rule)));
}

/* One line per stale ignore source. `error` (red) when `--fail-unused-ignores` makes it fatal,
 * `warning` (yellow) otherwise. `c` keys the styling to the destination stream (stdout or stderr). */
function unusedIgnoreLines(sources: IgnoreSource[], fail: boolean, c: typeof color): string[] {
	const label = fail ? c.red('error') : c.yellow('warning');
	return sources.map(
		(source) => `${label}: unused ignore rule — ${source.label} matched nothing in this run`,
	);
}

function printResult(result: AuditResult, collapse: boolean): void {
	const label = result.packageName ?? result.target;
	const version = result.packageVersion === undefined ? '' : `@${result.packageVersion}`;
	console.log(`\n${color.bold(`${label}${version}`)}  ${color.dim(result.target)}`);

	const resolved = result.source.resolved;
	if (resolved !== undefined) {
		// A spec/tag is a moving target — show exactly what was fetched.
		console.log(color.dim(`  resolved: ${resolved.tarball}`));
		console.log(color.dim(`  integrity: ${resolved.integrity}`));
	}

	if (result.ok && result.findings.length === 0 && result.notices.length === 0) {
		console.log(`  ${color.green('✓')} no undeclared imports`);
	}
	for (const notice of result.notices) {
		console.log(
			`  ${color.yellow('ℹ')} ${notice.surface.padEnd(SURFACE_WIDTH)}  ${notice.message}`,
		);
	}
	for (const finding of result.findings) {
		if (isCollapsed(finding, collapse) && finding.causedBy !== undefined) {
			// Collapsed to its producer (`--collapse-root-cause`): muted, does not fail the run.
			console.log(collapsedRow(finding, finding.causedBy.target, finding.causedBy.notice));
			continue;
		}
		console.log(findingRow(finding));
		console.log(`      ${color.dim('→')} ${finding.suggestion}`);
		if (finding.causedBy !== undefined) {
			// The owning package is itself a target in this run; fix it there, not here.
			console.log(
				`      ${color.dim('↳')} ${color.dim(`caused by ${finding.causedBy.target} (${finding.causedBy.notice}) — fix that producer`)}`,
			);
		}
	}
	for (const finding of result.ignored) {
		console.log(ignoredRow(finding));
	}
	for (const item of result.unchecked) {
		const where = color.dim(`(${item.reason}; ${item.firstSeenIn})`);
		console.log(
			`  ${color.yellow('?')} ${'unchecked'.padEnd(SURFACE_WIDTH)}  ${item.specifier}  ${where}`,
		);
	}
}

const SURFACE_WIDTH = 'unchecked'.length;
const KIND_WIDTH = '[types-unavailable]'.length;

/**
 * One aligned finding row: `✗ <surface> [<kind>] <specifier> (<file>)`, with the severity
 * carried by red (the symbol and `[kind]`). The headline carries the full *specifier*
 * (e.g. `react/jsx-runtime`), not just the owning package, so deep-import findings on the
 * same package stay distinguishable. Pad before coloring so ANSI width doesn't break columns.
 */
function findingRow(finding: Finding): string {
	const surface = finding.surface.padEnd(SURFACE_WIDTH);
	const kind = color.red(`[${finding.kind}]`.padEnd(KIND_WIDTH));
	const where = color.dim(`(${finding.firstSeenIn})`);
	return `  ${color.red('✗')} ${surface}  ${kind}  ${finding.specifier}  ${where}`;
}

/** A suppressed finding — same columns as {@link findingRow}, but muted (it does not fail). */
function ignoredRow(finding: Finding): string {
	const surface = finding.surface.padEnd(SURFACE_WIDTH);
	const kind = `[${finding.kind}]`.padEnd(KIND_WIDTH);
	return color.dim(
		`  – ${surface}  ${kind}  ${finding.specifier}  (${finding.firstSeenIn})  — ignored`,
	);
}

/** A finding collapsed to its producer under `--collapse-root-cause` — muted; does not fail. */
function collapsedRow(finding: Finding, producer: string, notice: string): string {
	const surface = finding.surface.padEnd(SURFACE_WIDTH);
	const kind = `[${finding.kind}]`.padEnd(KIND_WIDTH);
	return color.dim(
		`  ↳ ${surface}  ${kind}  ${finding.specifier}  (${finding.firstSeenIn})  — root cause: ${producer} (${notice})`,
	);
}

/** Reports a target whose audit could not run at all (acquisition/fetch failure). */
function printError(outcome: { target: string; error: string }): void {
	console.log(`\n${color.dim(outcome.target)}`);
	console.log(`  ${color.red('⚠ error')}  ${outcome.error}`);
}

/** Reports a non-package path that was skipped (neutral — does not affect the exit code). */
function printSkipped(outcome: { target: string; skipped: string }): void {
	console.log(`\n${color.dim(outcome.target)}`);
	console.log(color.dim(`  ↷ skipped  ${outcome.skipped}`));
}

/** `1 finding` / `2 findings` — pluralize a count noun. */
function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The message of an unknown thrown/rejected value, without leaking a non-Error's shape. */
function errorMessage(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}
	try {
		// A hostile value can have a throwing `toString`; never let formatting an error throw.
		return String(value);
	} catch {
		return 'unknown error';
	}
}

/**
 * A consolidated list of the failing findings, printed just above the summary so the actual
 * problems sit at the foot of a long log (e.g. a CI run) instead of buried in the per-target
 * blocks far up-scroll. Each row names its owning package, so it reads and greps standalone.
 * Skipped when nothing fails — the summary already says "0 findings". Collapsed findings (under
 * `--collapse-root-cause`) don't fail the run, so they're omitted here too.
 */
function printFindingsRecap(outcomes: Outcome[], collapse: boolean): void {
	const rows = outcomes.flatMap((outcome) =>
		'result' in outcome
			? outcome.result.findings
					.filter((finding) => !isCollapsed(finding, collapse))
					.map((finding) => recapRow(outcome.result.packageName ?? outcome.result.target, finding))
			: [],
	);
	if (rows.length === 0) {
		return;
	}
	console.log(`\n${color.bold('Findings:')}`);
	for (const row of rows) {
		console.log(row);
	}
}

/** A recap row — like {@link findingRow} but prefixed with the owning package so it stands alone. */
function recapRow(label: string, finding: Finding): string {
	const surface = finding.surface.padEnd(SURFACE_WIDTH);
	const kind = color.red(`[${finding.kind}]`.padEnd(KIND_WIDTH));
	const where = color.dim(`(${finding.firstSeenIn})`);
	return `  ${color.red('✗')} ${color.bold(label)}  ${surface}  ${kind}  ${finding.specifier}  ${where}`;
}

function printSummary(outcomes: Outcome[], collapse: boolean): void {
	const results = outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
	const skipped = outcomes.filter((o) => 'skipped' in o).length;
	const errors = outcomes.length - results.length - skipped;
	const allFindings = results.flatMap((result) => result.findings);
	// Under `--collapse-root-cause`, a correlated finding is counted separately and doesn't fail.
	const collapsed = allFindings.filter((f) => isCollapsed(f, collapse)).length;
	const findings = allFindings.length - collapsed;
	const ignored = results.reduce((sum, result) => sum + result.ignored.length, 0);
	const notices = results.reduce((sum, result) => sum + result.notices.length, 0);
	const noun = outcomes.length === 1 ? 'package' : 'packages';
	// The headline count is the severity signal: red when something fails, green when clean.
	const parts = [findings > 0 ? color.red(plural(findings, 'finding')) : color.green('0 findings')];
	if (collapsed > 0) {
		parts.push(color.dim(`${collapsed} collapsed`));
	}
	if (ignored > 0) {
		parts.push(color.dim(`${ignored} ignored`));
	}
	if (notices > 0) {
		parts.push(color.yellow(plural(notices, 'notice')));
	}
	if (skipped > 0) {
		parts.push(color.dim(`${skipped} skipped`));
	}
	if (errors > 0) {
		parts.push(color.red(plural(errors, 'error')));
	}
	console.log(`\n${outcomes.length} ${noun}, ${parts.join(', ')}.`);
}

/*
 * pacote / make-fetch-happen can emit a background promise rejection that isn't tied to any
 * call we await (an idle keep-alive socket, a cache write). Node's default is to crash on the
 * first unhandled rejection — which, mid-run, would discard everything buffered for output
 * (notably the single `--json` write at the end), leaving a redirect like `> result.json`
 * empty. Log it and keep going so the audit still finishes and writes its result.
 */
let backgroundError = false;

/* The progress spinner's cleanup handles, set once `main()` builds the reporter (no-ops until then, and no-ops entirely when stderr is not a TTY).
 * `clearProgress` erases the current line so a one-off stderr diagnostic doesn't land on top of the spinner; `stopProgress` ends it. */
let clearProgress: () => void = () => {};
let stopProgress: () => void = () => {};

process.on('unhandledRejection', (reason) => {
	// A swallowed background error means the result may be incomplete, so the run is no longer
	// "clean" — `finish()` reflects this in the exit code rather than reporting success.
	backgroundError = true;
	// Erase the spinner first so this warning isn't appended to the in-progress line (the spinner's next tick redraws it).
	clearProgress();
	console.error(`warning: ignored a background error — ${errorMessage(reason)}`);
});

/**
 * Exit with `code` after stdout has flushed. `process.exit()` truncates a piped/redirected
 * stream's still-buffered output (a large `--json` payload can be dropped); not exiting at all
 * would instead hang on pacote's lingering keep-alive sockets. The empty-string write's
 * callback fires once preceding writes have drained, so the data is safely out first. A
 * background rejection escalates the exit to 2 (re-checked at exit time, never lowering `code`).
 *
 * On a broken pipe (`… | head`) the flush can fail with `EPIPE`: the write callback may never
 * fire and an unhandled stream `error` would crash. Exit on whichever fires first — the write
 * callback, a stream `error` (swallowed), or a synchronous throw — so we never crash or hang.
 * `process.exitCode` is already set, so the exit code is correct on every path.
 */
function finish(code: number): void {
	// Idempotent — already called on the normal path; here it covers early/error exits.
	stopProgress();
	const resolved = (): number => (backgroundError ? Math.max(code, 2) : code);
	process.exitCode = resolved();
	const exit = (): void => process.exit(resolved());
	process.stdout.once('error', exit);
	try {
		process.stdout.write('', exit);
	} catch {
		exit();
	}
}

main()
	.then(finish)
	.catch((error: unknown) => {
		// Erase the spinner before the error so it doesn't land on top of the live line.
		stopProgress();
		console.error(errorMessage(error));
		finish(2);
	});
