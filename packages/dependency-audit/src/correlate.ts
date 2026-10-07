import type { AuditResult, Finding, NoticeKind } from './types.ts';

/** The coverage-notice kinds that mean a producer's own types are missing/unreachable. */
const COVERAGE_NOTICES = new Set<NoticeKind>([
	'types-not-built',
	'types-ignored-by-exports',
	'types-unreachable',
]);

/** The consumer finding kinds a producer's coverage gap can explain (package declared, types don't resolve). */
const CORRELATABLE_KINDS = new Set(['missing-types', 'types-unavailable']);

/** A producer target in the run: the spec as passed, its resolved package name, and its coverage notice. */
interface Producer {
	target: string;
	packageName: string;
	notice: NoticeKind;
}

/**
 * Correlates findings across a single multi-target run.
 *
 * When a consumer's finding is for a package that is *itself* an audited target carrying a coverage
 * notice (its own types aren't built/reachable), that producer is the real root cause: it rains a
 * look-alike `missing-types`/`types-unavailable` finding down on every consumer. This annotates each
 * such finding with `causedBy` (the producer target, package name, and notice) — pointing every consumer at the
 * one producer to fix — mutating the findings in place. It is purely additive: nothing is suppressed
 * or downgraded, so a genuine consumer-side issue is never hidden. Correlates within `results` only.
 */
export function correlateRootCauses(results: AuditResult[]): void {
	// Producer package name → its target + coverage notice. Keyed by name (imports resolve by name);
	// first-wins, so a duplicate-named target can't clobber an already-recorded producer.
	const producers = new Map<string, Producer>();
	for (const result of results) {
		const notice = result.notices.find((n) => COVERAGE_NOTICES.has(n.kind));
		if (
			result.packageName !== undefined &&
			notice !== undefined &&
			!producers.has(result.packageName)
		) {
			producers.set(result.packageName, {
				target: result.target,
				packageName: result.packageName,
				notice: notice.kind,
			});
		}
	}
	if (producers.size === 0) {
		return;
	}
	for (const result of results) {
		for (const finding of result.findings) {
			const producer = producers.get(finding.packageName);
			// Only a "declared but types don't resolve" finding is explained by the producer's gap;
			// an `undeclared` finding is a consumer-side bug, and we never self-attribute.
			if (
				producer !== undefined &&
				CORRELATABLE_KINDS.has(finding.kind) &&
				finding.packageName !== result.packageName
			) {
				finding.causedBy = {
					target: producer.target,
					packageName: producer.packageName,
					notice: producer.notice,
				};
			}
		}
	}
}

/**
 * Under `--collapse-root-cause`, a correlated finding (one annotated with `causedBy`) no longer
 * fails its consumer — the fix belongs to the producer, audited separately in the same run.
 */
export function isCollapsed(finding: Finding, collapse: boolean): boolean {
	return collapse && finding.causedBy !== undefined;
}

/** Whether a result still fails the run: it has a finding that isn't collapsed to a producer. */
export function resultFails(result: AuditResult, collapse: boolean): boolean {
	return result.findings.some((finding) => !isCollapsed(finding, collapse));
}
