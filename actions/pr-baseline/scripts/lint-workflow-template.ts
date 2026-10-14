/**
 * Validates the consumer workflow template with actionlint and zizmor, as a consumer would copy it.
 * The placeholders are filled with a fake pinned SHA and `main`; the trigger the design needs is allowed with a reason.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'workflow-template.yml');

/** actionlint's schema lags behind GitHub's `concurrency.queue` and the `stacked` activity of stacked PRs. */
const ACTIONLINT_IGNORES = [
	'unexpected key "queue" for "concurrency" section',
	'invalid activity type "stacked"',
];

/*
 * `pull_request_target` is the documented write path for fork PRs and the action never checks out PR code,
 * which is the condition zizmor's audit is about; the template documents this next to the trigger.
 */
const ZIZMOR_CONFIG = `rules:
  dangerous-triggers:
    ignore:
      - pr-baseline.yml
`;

function main(): number {
	const root = mkdtempSync(join(tmpdir(), 'pr-baseline-workflow-'));
	try {
		mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
		const filled = readFileSync(template, 'utf8')
			.replaceAll('@<sha>', `@${'0'.repeat(40)}`)
			.replaceAll('BASE', 'main');
		const workflow = join(root, '.github', 'workflows', 'pr-baseline.yml');
		writeFileSync(workflow, filled);
		writeFileSync(join(root, '.github', 'zizmor.yml'), ZIZMOR_CONFIG);
		let failed = false;
		for (const [name, args] of [
			['actionlint', ['-ignore', ACTIONLINT_IGNORES.join('|'), workflow]],
			[
				'zizmor',
				['--no-progress', '--offline', '--format', 'plain', '.github/workflows/pr-baseline.yml'],
			],
		] as const) {
			try {
				execFileSync(name, [...args], { cwd: root, stdio: 'inherit' });
				console.log(`${name}: workflow template is clean.`);
			} catch (error) {
				failed = true;
				const code = (error as { status?: number }).status;
				console.error(`${name} failed${code === undefined ? '' : ` (${code})`}.`);
			}
		}
		return failed ? 1 : 0;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	process.exitCode = main();
}
