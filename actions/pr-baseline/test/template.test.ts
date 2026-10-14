import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const template = readFileSync(join(import.meta.dirname, '..', 'workflow-template.yml'), 'utf8');

/** The `pull_request_target` trigger is safe only while the refresh-pr-status job never checks out or runs PR code. */
describe('consumer workflow template', () => {
	// The commented-out backfill follows the second job, so the capture stops where the comments start.
	const active = template.split('\n# Uncomment during adoption')[0] ?? '';
	const [, status = '', refresh = ''] =
		/^jobs:\n  refresh-pr-status:\n([\s\S]*?)\n  refresh-pr-statuses:\n([\s\S]*)$/m.exec(active) ??
		[];
	/** The backfill job as a consumer would have it, with the comment markers taken off. */
	const backfill = (template.split('\n# Uncomment during adoption')[1] ?? '')
		.split('\n')
		.filter((line) => line.startsWith('#'))
		.map((line) => line.replace(/^#ex?/, '').replace(/^# ?/, ''))
		.join('\n');

	it('keeps the refresh-pr-status job free of checkouts and shell steps', () => {
		expect(status.length).toBeGreaterThan(0);
		expect(status).not.toContain('actions/checkout');
		expect(status).not.toMatch(/^\s+run:/m);
		expect(status).toContain('statuses: write');
		expect(status).not.toContain('pull-requests');
	});

	it('gives the refresh job a treeless full-history checkout without credentials', () => {
		expect(refresh).toContain('fetch-depth: 0');
		expect(refresh).toContain('filter: tree:0');
		expect(refresh).toContain('persist-credentials: false');
		expect(refresh).toContain('queue: max');
	});

	it('defines the baseline list once and reads it in both jobs', () => {
		const env = /^  PR_BASELINES: '(.*)'$/m.exec(template)?.[1] ?? '';
		expect(Array.isArray(JSON.parse(env))).toBe(true);
		// Comment lines excluded: the commented-out backfill job reads it too.
		const uncommented = template
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(uncommented.match(/baselines: \$\{\{ env\.PR_BASELINES \}\}/g)).toHaveLength(2);
	});

	it('runs once per merge and keeps the counts in the log rather than an artifact', () => {
		// A merge fires `push` too, so a `closed` trigger would only queue the same job a second time.
		expect(template).toContain(
			'types: [opened, synchronize, reopened, ready_for_review, edited, stacked]',
		);
		expect(refresh).not.toContain("github.event.action == 'closed'");
		// The results file is still an output for a workflow that wants it.
		expect(template).not.toContain('upload-artifact');
	});

	it('wires the dispatch scope into the refresh job', () => {
		expect(template).toContain("scope: ${{ inputs.scope || '' }}");
		expect(template).toContain('options: [corrections, unstamped, all]');
		expect(refresh).toContain('max-writes-per-run: 300');
	});

	it('offers a backfill job that runs on its own daily tick and is throttled', () => {
		expect(backfill).toContain(' backfill:');
		// Without the schedule guard it would fire on every event the workflow serves.
		expect(backfill).toContain("github.event.schedule == '23 4 * * *'");
		// And the ordinary refresh must match only its own cron, or both would run at that minute.
		expect(refresh).toContain("github.event.schedule == '17 * * * *'");
		expect(refresh).not.toContain("github.event_name == 'schedule'");
		expect(backfill).toContain('mode: refresh-pr-statuses');
		expect(backfill).toContain('scope: unstamped');
		expect(backfill).toContain('max-writes-per-run: 150');
		expect(backfill).toContain('statuses: write');
		expect(backfill).toContain('group: pr-baseline-backfill');
		expect(backfill).toContain('baselines: ${{ env.PR_BASELINES }}');
		expect(backfill).toContain('fetch-depth: 0');
	});
});
