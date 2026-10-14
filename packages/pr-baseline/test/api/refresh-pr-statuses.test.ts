import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/git/repo.ts';
import { GitHubError } from '../../src/github/errors.ts';
import type { Ancestry } from '../../src/index.ts';
import { harness, sha } from '../helpers/client.ts';
import type { FakeGitHub } from '@mawesome/testing/github';

const PASS = 'Contains the required main changes.';

/** Baseline at 3; PRs 1 (current), 2 (stale), 3 (stale but already stamped), 4 (current, wrong creator). */
function populate(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	gh.commit(sha(11), [sha(4)]);
	gh.commit(sha(12), [sha(2)]);
	gh.commit(sha(13), [sha(2)]);
	gh.commit(sha(14), [sha(5)]);
	gh.pull({ number: 1, headSha: sha(11) });
	gh.pull({ number: 2, headSha: sha(12) });
	gh.pull({ number: 3, headSha: sha(13) });
	gh.pull({ number: 4, headSha: sha(14) });
	gh.status(sha(13), {
		state: 'failure',
		description: 'Merge or rebase main to include: pr-baseline',
		targetUrl: `https://github.com/acme/widgets/compare/${sha(13)}...main`,
	});
	gh.status(sha(14), { state: 'success', description: PASS, creator: 'someone-else' });
}

const stack = (position: number) => ({ id: 1, base: 'main', position });

describe('refresh-pr-statuses', () => {
	it('writes only statuses that differ and reports the counts', async () => {
		const { client, github } = harness({}, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			openPulls: 4,
			written: 3,
			skipped: 1,
			failed: 0,
			incomplete: false,
		});
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('success');
		expect(github.latestStatus(sha(12), 'PR baseline')?.state).toBe('failure');
		expect(github.latestStatus(sha(14), 'PR baseline')?.creator).toBe('github-actions[bot]');
		expect(result.entries.map((entry) => [entry.number, entry.outcome])).toEqual([
			[4, 'written'],
			[3, 'skipped'],
			[2, 'written'],
			[1, 'written'],
		]);
	});

	it('stamps every open PR of a stack that lands on the base', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(4)]);
			gh.commit(sha(12), [sha(11)]);
			gh.commit(sha(13), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11), stack: stack(1) });
			gh.pull({ number: 2, headSha: sha(12), baseRef: 'feature/a', stack: stack(2) });
			gh.pull({ number: 3, headSha: sha(13), baseRef: 'feature/b', stack: stack(3) });
			gh.pull({
				number: 4,
				headSha: sha(13),
				baseRef: 'feature/c',
				state: 'closed',
				stack: stack(4),
			});
			gh.pull({ number: 5, headSha: sha(13), baseRef: 'feature/d' });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ openPulls: 3, written: 3 });
		expect(github.latestStatus(sha(12), 'PR baseline')?.state).toBe('success');
		expect(github.latestStatus(sha(13), 'PR baseline')?.state).toBe('failure');
		// The listing and one read of the PRs the stack adds.
		expect(github.requests(/graphql/)).toHaveLength(2);
	});

	it('lists the PRs against the base on a server without stacks', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			gh.stacks = false;
		});
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({
			openPulls: 4,
			incomplete: false,
		});
		// The stack query is rejected once, then the run continues without it.
		expect(github.requests(/graphql/)).toHaveLength(2);
	});

	it('is idempotent on the second run', async () => {
		const { client, github } = harness({}, populate);
		await client.refreshPrStatuses();
		const again = await client.refreshPrStatuses();
		expect(again).toMatchObject({ written: 0, skipped: 4 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stamps every PR when the baseline is absent', async () => {
		const { client } = harness({}, (gh) => {
			gh.commit(sha(11), [sha(1)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.refreshPrStatuses();
		expect(result.written).toBe(1);
		expect(result.entries[0]?.verdict?.kind).toBe('pass');
	});

	it('excludes drafts only when configured', async () => {
		const { client } = harness({ includeDrafts: false }, (gh) => {
			gh.commit(sha(11), [sha(1)]);
			gh.pull({ number: 1, headSha: sha(11), isDraft: true });
		});
		expect((await client.refreshPrStatuses()).openPulls).toBe(0);
	});

	it('logs writes in a dry run without making them', async () => {
		const { client, github, logs } = harness({ dryRun: true }, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 3, dryRun: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		expect(logs.filter((line) => line.startsWith('[dry-run]'))).toHaveLength(3);
	});

	it('pauses at the per-run write cap, incomplete but green, having written something', async () => {
		const { client, github } = harness({ maxWritesPerRun: 2 }, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			written: 2,
			incomplete: true,
			paused: true,
			reason: 'write-cap',
		});
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
	});

	it('pauses on a rate limit met after writing something', async () => {
		const { client, github } = harness({}, populate);
		const original = github.fetch;
		github.fetch = (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			// The limit arrives while evaluating the next PR, so no write of this run failed.
			if (/\/statuses\//.test(url) && init?.method === 'POST') {
				github.overrides.push({
					path: /\/compare\//,
					status: 403,
					headers: { 'x-ratelimit-remaining': '0' },
				});
			}
			return original.call(github, input, init);
		};
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			failed: 0,
			incomplete: true,
			paused: true,
			reason: 'rate-limit',
		});
		expect(result.written).toBeGreaterThan(0);
	});

	it('pauses on the primary budget once it has written something', async () => {
		const { client, warnings } = harness({}, (gh) => {
			populate(gh);
			// Enough headroom for a write or two, then the reserve stops the run.
			gh.rateLimitRemaining = 58;
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			failed: 0,
			incomplete: true,
			paused: true,
			reason: 'primary-budget',
		});
		expect(result.written).toBeGreaterThan(0);
		expect(warnings.join('\n')).toContain('Paused on the primary budget:');
	});

	it('paces writes against the per-minute cap', async () => {
		const { client, sleeps } = harness({ maxWritesPerMinute: 2 }, populate);
		const result = await client.refreshPrStatuses();
		expect(result.written).toBe(3);
		expect(sleeps).toEqual([60_000]);
	});

	it('stops when the primary budget reaches the reserve', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			gh.rateLimitRemaining = 55;
		});
		const result = await client.refreshPrStatuses();
		expect(result.incomplete).toBe(true);
		expect(result.reason).toBe('primary-budget');
		expect(github.requests(/\/statuses\//, 'POST').length).toBeLessThan(3);
	});

	it('stops on a rate limit while writing and keeps the summary', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /\/statuses\//,
			method: 'POST',
			status: 403,
			headers: { 'x-ratelimit-remaining': '0' },
		});
		const result = await client.refreshPrStatuses();
		// A rate limit answering the write itself is a failure, so it is not a pause.
		expect(result).toMatchObject({
			written: 0,
			failed: 1,
			incomplete: true,
			paused: false,
			reason: 'rate-limit',
		});
	});

	it('returns an incomplete summary when the listing is rate limited', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED' }] },
		});
		const summary = await client.refreshPrStatuses();
		expect(summary).toMatchObject({
			openPulls: 0,
			written: 0,
			incomplete: true,
			reason: 'rate-limit',
		});
	});

	it('counts the status cap as failed for that PR and continues', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			gh.overrides.push({
				path: new RegExp(`/statuses/${sha(12)}`),
				method: 'POST',
				status: 422,
				body: {
					message: 'Validation Failed',
					errors: [{ message: 'This SHA and context has reached the maximum number of statuses.' }],
				},
			});
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 2, failed: 1, incomplete: true, reason: 'failed' });
		expect(result.entries.find((entry) => entry.number === 2)?.error).toContain(
			'maximum number of statuses',
		);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stops after a permission error instead of failing every PR', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /\/statuses\//,
			method: 'POST',
			status: 403,
			times: 10,
			headers: { 'x-ratelimit-remaining': '500' },
			body: { message: 'Resource not accessible by integration' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ failed: 1, incomplete: true, reason: 'failed' });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('passes every PR when a baseline is not on the base branch, instead of refusing', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
			gh.commit(sha(11), [sha(5)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(2) });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			misconfigured: ['pr-baseline'],
			written: 2,
			failed: 0,
			incomplete: false,
		});
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
		expect(github.latestStatus(sha(11), 'PR baseline')).toMatchObject({
			state: 'success',
			description: 'Baseline misconfigured: pr-baseline not on main; ask a maintainer.',
		});
	});

	it('recognises its own statuses under an App bot creator, which GraphQL names without the [bot] suffix', async () => {
		const { client, github } = harness({ creator: 'my-app[bot]' }, (gh) => {
			populate(gh);
			gh.creator = 'my-app[bot]';
			gh.status(sha(11), { state: 'success', description: PASS, creator: 'my-app[bot]' });
		});
		const result = await client.refreshPrStatuses();
		expect(result.entries.find((entry) => entry.number === 1)?.outcome).toBe('skipped');
		expect(
			github.calls.filter((call) => call.method === 'POST' && call.path.includes(sha(11))),
		).toHaveLength(0);
	});

	it('fails before evaluating anything when the creator cannot be resolved', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			populate(gh);
			gh.user = null;
		});
		await expect(client.refreshPrStatuses()).rejects.toThrow(/--creator/);
		expect(github.requests(/graphql/)).toHaveLength(0);
	});

	it('pages through the listing', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.pageSize = 2;
			for (let n = 1; n <= 5; n++) {
				gh.commit(sha(20 + n), [sha(4)]);
				gh.pull({ number: n, headSha: sha(20 + n) });
			}
		});
		const result = await client.refreshPrStatuses();
		expect(result.openPulls).toBe(5);
		expect(github.requests(/graphql/)).toHaveLength(3);
	});

	it('combines scoped baselines per PR', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'repo' }, { name: 'pkg-a', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('repo', sha(2));
				gh.baseline('pkg-a', sha(4));
				gh.commit(sha(11), [sha(3)]);
				gh.commit(sha(12), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.pull({ number: 2, headSha: sha(12) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/x.ts']);
				gh.files.set(`${sha(5)}...${sha(12)}`, ['docs/x.md']);
			},
		);
		const result = await client.refreshPrStatuses();
		const byNumber = new Map(result.entries.map((entry) => [entry.number, entry.verdict]));
		expect(byNumber.get(1)?.kind).toBe('fail');
		expect(byNumber.get(1)?.missing).toEqual(['pkg-a']);
		expect(byNumber.get(2)?.kind).toBe('pass');
		expect(byNumber.get(2)?.applicable).toEqual(['repo']);
	});
});

describe('refresh guards', () => {
	it('fails outright on the first creator mismatch instead of writing every PR', async () => {
		const { client, github } = harness({ creator: 'expected[bot]' }, populate);
		await expect(client.refreshPrStatuses()).rejects.toThrow(/expected\[bot\]/);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('rechecks the primary reserve after evaluation spent requests', async () => {
		const { client, github, warnings } = harness({}, (gh) => {
			populate(gh);
			// Listing and the base-membership compare bring the count to the reserve edge before the first write.
			gh.rateLimitRemaining = 55;
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, reason: 'primary-budget', paused: false });
		// A run starved of budget before its first write says which, so an operator looks at the right thing.
		expect(warnings.join('\n')).toContain(
			"another workflow is consuming the repository's request budget",
		);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('returns a summary when the default-branch lookup is rate limited', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /^\/repos\/acme\/widgets$/,
			status: 403,
			headers: { 'x-ratelimit-remaining': '0' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ openPulls: 0, incomplete: true, reason: 'rate-limit' });
	});
});

describe('refresh shared heads', () => {
	it('writes a head shared by two PRs once', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, skipped: 1 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
		expect(github.requests(/compare/)).toHaveLength(2);
	});

	it('keeps the resolved base in a rate-limited summary', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED' }] },
		});
		const result = await client.refreshPrStatuses();
		expect(result.base).toBe('main');
		expect(result.baselines[0]?.sha).toBe(sha(3));
	});
});

describe('refresh with a custom reporter', () => {
	it('asks the injected reporter for the current status instead of the listing', async () => {
		const current: string[] = [];
		const written: string[] = [];
		const { client, github } = harness(
			{
				reporter: {
					current(target) {
						current.push(target);
						return Promise.resolve({
							state: 'success',
							description: PASS,
							targetUrl: null,
							creator: 'github-actions[bot]',
						});
					},
					write(target) {
						written.push(target);
						return Promise.resolve();
					},
				},
			},
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(11) });
			},
		);
		const result = await client.refreshPrStatuses();
		expect(current).toEqual([sha(11)]);
		expect(written).toEqual([]);
		expect(result).toMatchObject({ written: 0, skipped: 1 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});
});

describe('refresh round 4', () => {
	it('records a terminal failure once for a shared head', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
			gh.overrides.push({
				path: new RegExp(`/statuses/${sha(11)}`),
				method: 'POST',
				status: 422,
				body: { message: 'This SHA and context has reached the maximum number of statuses.' },
			});
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 2, incomplete: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
		expect(github.requests(/compare/)).toHaveLength(2);
	});

	it('turns a rate limit from a custom reporter into an incomplete summary', async () => {
		const { client } = harness(
			{
				reporter: {
					current: () => Promise.reject(new GitHubError('rate-limit', 'custom', 'limited')),
					write: () => Promise.resolve(),
				},
			},
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(11) });
			},
		);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, incomplete: true, reason: 'rate-limit' });
	});

	it('binds nobody to an absent scoped baseline and matches deleted files by name', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'repo' }, { name: 'pkg-a', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('repo', sha(2));
				gh.commit(sha(11), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/removed.ts']);
			},
		);
		const result = await client.refreshPrStatuses();
		const verdict = result.entries[0]?.verdict;
		expect(verdict?.applicable).toEqual(['repo', 'pkg-a']);
		expect(verdict?.kind).toBe('pass');
	});
});

/** Baseline at 4; PR 1 green and now failing, 2 already red, 3 unstamped, 4 carrying a foreign `error`. */
function scoped(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(4));
	for (const n of [11, 12, 13, 14]) {
		gh.commit(sha(n), [sha(3)]);
	}
	gh.pull({ number: 1, headSha: sha(11) });
	gh.pull({ number: 2, headSha: sha(12) });
	gh.pull({ number: 3, headSha: sha(13) });
	gh.pull({ number: 4, headSha: sha(14) });
	gh.status(sha(11), { state: 'success', description: PASS });
	gh.status(sha(12), {
		state: 'failure',
		description: 'Merge or rebase main to include: pr-baseline',
		targetUrl: `https://github.com/acme/widgets/compare/${sha(12)}...main`,
	});
	gh.status(sha(14), { state: 'error', description: 'left by a previous integration' });
}

/** An adapter that prepares, so the second listing and the head map run, and records what it was asked for. */
function preparingAdapter(): { adapter: Ancestry; pulls: number[][] } {
	const pulls: number[][] = [];
	return {
		pulls,
		adapter: {
			name: 'api',
			isAncestor: (ancestor, descendant) => Promise.resolve(ancestor <= descendant),
			changedFiles: () => Promise.resolve([]),
			prepare(input) {
				pulls.push(input.pulls);
				return Promise.resolve({ heads: new Map() });
			},
		},
	};
}

/** One green PR that still passes, carrying a description from an older release. */
function drifted(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	gh.commit(sha(11), [sha(4)]);
	gh.pull({ number: 1, headSha: sha(11) });
	gh.status(sha(11), { state: 'success', description: 'wording from an older release' });
}

describe('refresh scope', () => {
	it('corrects only the PRs a forward move can have turned red', async () => {
		// `scope: undefined` is the library's own default, which is what a consumer that asks for nothing gets.
		const { client, github } = harness({ scope: undefined }, scoped);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			scope: 'corrections',
			openPulls: 4,
			selected: 1,
			excluded: 3,
			written: 1,
			skipped: 0,
			remaining: 0,
		});
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('failure');
		// The red, the unstamped and the `error` PR are all left exactly as they were.
		expect(github.latestStatus(sha(12), 'PR baseline')?.description).toBe(
			'Merge or rebase main to include: pr-baseline',
		);
		expect(github.latestStatus(sha(13), 'PR baseline')).toBeNull();
		expect(github.latestStatus(sha(14), 'PR baseline')?.state).toBe('error');
	});

	it('stamps only PRs with no status under unstamped', async () => {
		const { client, github } = harness({ scope: 'unstamped' }, scoped);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ scope: 'unstamped', selected: 1, excluded: 3, written: 1 });
		expect(github.latestStatus(sha(13), 'PR baseline')?.state).toBe('failure');
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('success');
	});

	it('reaches a PR carrying an `error` status only under all', async () => {
		const { client, github } = harness({ scope: 'all' }, scoped);
		const result = await client.refreshPrStatuses();
		// Every PR but the already-red one differs materially.
		expect(result).toMatchObject({
			scope: 'all',
			selected: 4,
			excluded: 0,
			written: 3,
			skipped: 1,
		});
		expect(github.latestStatus(sha(14), 'PR baseline')?.state).toBe('failure');
	});

	it('counts a text-only difference as cosmetic and writes it only under all', async () => {
		const corrections = harness({ scope: 'corrections' }, drifted);
		await expect(corrections.client.refreshPrStatuses()).resolves.toMatchObject({
			selected: 1,
			written: 0,
			cosmetic: 1,
			skipped: 0,
			remaining: 0,
			incomplete: false,
		});
		expect(corrections.github.latestStatus(sha(11), 'PR baseline')?.description).toBe(
			'wording from an older release',
		);
		const all = harness({ scope: 'all' }, drifted);
		await expect(all.client.refreshPrStatuses()).resolves.toMatchObject({
			written: 1,
			cosmetic: 0,
		});
		expect(all.github.latestStatus(sha(11), 'PR baseline')?.description).toBe(PASS);
	});

	it('spends the last write on a material difference, not a cosmetic one', async () => {
		const { client, github } = harness({ scope: 'all', maxWritesPerRun: 1 }, (gh) => {
			gh.baseline('pr-baseline', sha(4));
			// The listing is newest first, so the cosmetic PR is reached before the material one.
			gh.commit(sha(12), [sha(5)]);
			gh.commit(sha(11), [sha(3)]);
			gh.pull({ number: 2, headSha: sha(12) });
			gh.pull({ number: 1, headSha: sha(11) });
			gh.status(sha(12), { state: 'success', description: 'older wording' });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, paused: true, reason: 'write-cap' });
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('failure');
		expect(github.latestStatus(sha(12), 'PR baseline')?.description).toBe('older wording');
	});

	it('reconciles against the heads stage 2 fetched, not stage 1', async () => {
		let calls = 0;
		const adapter: Ancestry = {
			name: 'api',
			isAncestor: (ancestor, descendant) => Promise.resolve(ancestor <= descendant),
			changedFiles: () => Promise.resolve([]),
			prepare() {
				calls++;
				// Only the second call knows any PR, so a run that kept stage 1's result would see no head at all.
				return Promise.resolve({
					heads: calls === 1 ? new Map() : new Map([[1, sha(19)]]),
				});
			},
		};
		const { client } = harness({ scope: 'corrections', ancestryAdapter: adapter }, (gh) => {
			scoped(gh);
			gh.commit(sha(19), [sha(3)]);
		});
		const result = await client.refreshPrStatuses();
		// PR 1's fetched head differs from the listed one, so it is re-read and evaluated at the new head.
		/* The re-read says the PR is still at its listed head, so it is deferred rather than stamped.
		 * With stage 1's empty head map kept instead, PR 1 would simply have been written. */
		expect(result.entries[0]).toMatchObject({ number: 1, outcome: 'deferred' });
	});

	it('asks the adapter to prepare only the selected PR heads', async () => {
		const strict = strictAdapter();
		const { client } = harness({ scope: 'corrections', ancestryAdapter: strict.adapter }, scoped);
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({ selected: 1 });
		// The first call settles the baselines against the base head; only the second knows the scope.
		expect(strict.preparedPulls).toEqual([[], [1]]);
	});

	it('counts a PR that closes between the two listings in openPulls', async () => {
		const preparing = preparingAdapter();
		const { client, github } = harness(
			{ scope: 'corrections', ancestryAdapter: preparing.adapter },
			scoped,
		);
		let listings = 0;
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original.call(github, input, init);
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/graphql') && ++listings === 1) {
				const pull = github.pulls.get(1);
				if (pull) {
					pull.state = 'closed';
				}
			}
			return response;
		};
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			openPulls: 4,
			selected: 1,
			excluded: 3,
			closed: 1,
			written: 0,
			remaining: 0,
		});
		expect(result.selected + result.excluded).toBe(result.openPulls);
	});

	it('tells a paused forced sweep that the default scope will not continue it', async () => {
		const { client, warnings } = harness({ scope: undefined, maxWritesPerRun: 1 }, scoped);
		const result = await client.moveBaseline({
			force: true,
			to: sha(5),
			refreshPrStatuses: true,
		});
		expect(result.refresh).toMatchObject({ scope: 'all', paused: true });
		// The move that promoted the scope will not repeat, so the next run is back to corrections.
		expect(warnings.join('\n')).toContain(
			'at scope all; a run at the default scope will not continue it',
		);
	});

	it('logs progress once the write and the time threshold have both passed', async () => {
		// The throttle's own thresholds are a unit test; this is the only case that proves the loop uses it.
		const { client, logs } = harness({ scope: 'all', maxWritesPerMinute: 1 }, (gh) => {
			gh.baseline('pr-baseline', sha(4));
			for (let n = 1; n <= 60; n += 1) {
				gh.commit(sha(100 + n), [sha(3)]);
				gh.pull({ number: n, headSha: sha(100 + n) });
			}
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ selected: 60, written: 60 });
		const progress = logs.filter((line) => line.startsWith('Written '));
		expect(progress).toEqual(['Written 50 of at most 60; 10 PRs still to visit.']);
	});

	it('names the population left by the scope in a progress line', async () => {
		const { client, logs } = harness({ scope: 'unstamped', maxWritesPerMinute: 1 }, (gh) => {
			gh.baseline('pr-baseline', sha(4));
			for (let n = 1; n <= 55; n += 1) {
				gh.commit(sha(100 + n), [sha(3)]);
				gh.pull({ number: n, headSha: sha(100 + n) });
			}
		});
		await client.refreshPrStatuses();
		expect(logs.filter((line) => line.startsWith('Written '))).toEqual([
			'Written 50 of at most 55; 5 PRs still unstamped.',
		]);
	});

	it('says what it plans to do before doing it, and what is left when it pauses', async () => {
		const { client, logs, warnings } = harness({ scope: 'all', maxWritesPerRun: 2 }, scoped);
		await client.refreshPrStatuses();
		expect(logs).toContain('4 open PRs: 1 passing, 1 failing, 1 other, 1 unstamped.');
		expect(logs).toContain('Scope all: 4 PRs to visit, at most 2 writes.');
		expect(warnings.join('\n')).toContain(
			'Paused on the write cap: 2 written, 0 skipped, 0 cosmetic, 0 failed, 2 remaining.',
		);
		expect(warnings.join('\n')).toContain('About 1 more run at this cap');
	});

	it('closes a complete run with its counts', async () => {
		const { client, logs } = harness({ scope: 'all' }, scoped);
		await client.refreshPrStatuses();
		expect(logs).toContain(
			'Refresh complete: 3 written, 1 skipped, 0 cosmetic, 0 failed, 0 remaining.',
		);
	});

	it('subtracts every accounted outcome from remaining, not just the writes', async () => {
		const { client } = harness({ scope: 'all', maxWritesPerRun: 1 }, (gh) => {
			scoped(gh);
			// A fifth PR already current and a sixth that passes but carries older wording.
			gh.commit(sha(15), [sha(3)]);
			gh.commit(sha(16), [sha(4)]);
			gh.pull({ number: 5, headSha: sha(15) });
			gh.pull({ number: 6, headSha: sha(16) });
			gh.status(sha(15), {
				state: 'failure',
				description: 'Merge or rebase main to include: pr-baseline',
				targetUrl: `https://github.com/acme/widgets/compare/${sha(15)}...main`,
			});
			gh.status(sha(16), { state: 'success', description: 'older wording' });
		});
		const result = await client.refreshPrStatuses();
		// Newest first, so 6 (cosmetic, queued) and 5 (current) are reached before the cap bites.
		expect(result).toMatchObject({ selected: 6, written: 1, skipped: 1, cosmetic: 0 });
		expect(result.remaining).toBe(
			result.selected -
				(result.written +
					result.skipped +
					result.cosmetic +
					result.closed +
					result.deferred +
					result.outOfScope +
					result.failed),
		);
		expect(result.remaining).toBeGreaterThan(0);
	});

	it('leaves a queued cosmetic PR unaccounted when the run stops before draining it', async () => {
		const { client, github } = harness({ scope: 'all', maxWritesPerRun: 1 }, (gh) => {
			gh.baseline('pr-baseline', sha(4));
			gh.commit(sha(12), [sha(5)]);
			gh.commit(sha(11), [sha(3)]);
			gh.pull({ number: 2, headSha: sha(12) });
			gh.pull({ number: 1, headSha: sha(11) });
			gh.status(sha(12), { state: 'success', description: 'older wording' });
		});
		const result = await client.refreshPrStatuses();
		// The cap is spent on the material write, so the queued cosmetic one is neither written nor counted.
		expect(result).toMatchObject({ written: 1, cosmetic: 0, skipped: 0, remaining: 1 });
		expect(github.latestStatus(sha(12), 'PR baseline')?.description).toBe('older wording');
	});

	it('counts a second PR sharing a head left alone as cosmetic, not as already current', async () => {
		const { client } = harness({ scope: 'corrections' }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
			gh.status(sha(11), { state: 'success', description: 'wording from an older release' });
		});
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({
			selected: 2,
			cosmetic: 2,
			skipped: 0,
			written: 0,
		});
	});

	it('leaves both PRs sharing a queued cosmetic head unaccounted when the run stops first', async () => {
		const { client, github } = harness({ scope: 'all', maxWritesPerRun: 1 }, (gh) => {
			gh.baseline('pr-baseline', sha(4));
			// 3 and 2 share a head that only differs in wording; 1 differs materially and takes the cap.
			gh.commit(sha(12), [sha(5)]);
			gh.commit(sha(11), [sha(3)]);
			gh.pull({ number: 3, headSha: sha(12) });
			gh.pull({ number: 2, headSha: sha(12) });
			gh.pull({ number: 1, headSha: sha(11) });
			gh.status(sha(12), { state: 'success', description: 'older wording' });
		});
		const result = await client.refreshPrStatuses();
		// Counting the sibling before the write landed would report skipped 1 and remaining 1.
		expect(result).toMatchObject({
			selected: 3,
			written: 1,
			skipped: 0,
			cosmetic: 0,
			remaining: 2,
		});
		expect(github.latestStatus(sha(12), 'PR baseline')?.description).toBe('older wording');
	});

	it('accounts a second PR sharing a queued cosmetic head only once the write lands', async () => {
		const { client, github } = harness({ scope: 'all' }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
			gh.status(sha(11), { state: 'success', description: 'older wording' });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ selected: 2, written: 1, skipped: 1, remaining: 0 });
		// One physical write for the shared head, and the sibling is not claimed to be current before it.
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('reports what the scope selected when a rate limit stops it after the listing', async () => {
		const { client, github } = harness({ scope: 'corrections' }, scoped);
		// The listing succeeds; the base-membership compare that follows does not.
		github.overrides.push({
			path: /\/compare\//,
			status: 403,
			headers: { 'x-ratelimit-remaining': '0' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			openPulls: 4,
			selected: 1,
			excluded: 3,
			written: 0,
			remaining: 1,
			reason: 'rate-limit',
		});
	});

	it('promotes a defaulted scope to all for a custom reporter, and warns', async () => {
		const written: string[] = [];
		const { client, warnings } = harness(
			{
				scope: undefined,
				reporter: {
					current: () => Promise.resolve(null),
					write: (sha_) => {
						written.push(sha_);
						return Promise.resolve();
					},
				},
			},
			scoped,
		);
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({ scope: 'all', selected: 4 });
		expect(written).toHaveLength(4);
		expect(warnings.some((line) => line.includes('custom reporter'))).toBe(true);
	});

	it('refuses an explicit scope for a custom reporter, and a move refuses before it moves', async () => {
		const reporter = {
			current: () => Promise.resolve(null),
			write: () => Promise.resolve(),
		};
		const { client, github } = harness({ scope: 'corrections', reporter }, scoped);
		await expect(client.refreshPrStatuses()).rejects.toThrow(/custom reporter/);
		// The move would otherwise write the ref and only then reject, leaving statuses unrefreshed.
		await expect(
			client.moveBaseline({ force: true, to: sha(5), refreshPrStatuses: true }),
		).rejects.toThrow(/custom reporter/);
		expect(github.baselineAt('pr-baseline')).toBe(sha(4));
		// The other commands are untouched by the scope, so the same client still serves them.
		await expect(client.report()).resolves.toMatchObject({ openPulls: 4 });
		await expect(client.refreshPrStatus({ pr: 1, report: true })).resolves.toMatchObject({
			written: true,
		});
		await expect(
			client.moveBaseline({ force: true, to: sha(5), refreshPrStatuses: false }),
		).resolves.toMatchObject({ moves: [{ moved: true }] });
	});

	it('refreshes every PR after a forced move and after an off-base baseline', async () => {
		const forced = harness({ scope: 'corrections' }, scoped);
		await expect(
			forced.client.moveBaseline({ force: true, to: sha(5), refreshPrStatuses: true }),
		).resolves.toMatchObject({ refresh: { scope: 'all', selected: 4 } });
		const off = harness({ scope: 'corrections' }, (gh) => {
			scoped(gh);
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
		});
		await expect(off.client.refreshPrStatuses()).resolves.toMatchObject({
			scope: 'all',
			selected: 4,
		});
	});
});

describe('refresh write accounting', () => {
	it('counts failed writes against the per-run cap and the pacing', async () => {
		const { client, github, sleeps } = harness(
			{ maxWritesPerRun: 2, maxWritesPerMinute: 1 },
			(gh) => {
				populate(gh);
				gh.overrides.push({
					path: /\/statuses\//,
					method: 'POST',
					status: 422,
					times: 10,
					body: { message: 'This SHA and context has reached the maximum number of statuses.' },
				});
			},
		);
		const result = await client.refreshPrStatuses();
		// Failures are not a pause, whatever stopped the run: something needs looking at.
		expect(result).toMatchObject({
			written: 0,
			failed: 2,
			incomplete: true,
			paused: false,
			reason: 'write-cap',
		});
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
		expect(sleeps).toEqual([60_000]);
	});
});

describe('refresh transport retries', () => {
	it('retries a transient write failure through the budget and succeeds', async () => {
		const { client, github } = harness({ maxWritesPerRun: 10 }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 500, times: 2 });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, failed: 0 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stops at the write cap in the middle of a retry sequence', async () => {
		const { client, github, warnings } = harness({ maxWritesPerRun: 2 }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 500, times: 5 });
		});
		const result = await client.refreshPrStatuses();
		// A run that made no progress is indistinguishable from one that never will.
		expect(result).toMatchObject({
			written: 0,
			incomplete: true,
			paused: false,
			reason: 'write-cap',
		});
		// Its own cap went on abandoned attempts, which is not another workflow's doing.
		expect(warnings.join('\n')).toContain('the cap went on attempts that were abandoned');
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
	});

	it('fails the PR after three exhausted server errors', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 502, times: 5 });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 1, incomplete: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('binds a PR touching two scopes to both baselines', async () => {
		const { client } = harness(
			{
				baselines: [
					{ name: 'pkg-a', scope: ['packages/a/'] },
					{ name: 'pkg-b', scope: ['packages/b/'] },
				],
			},
			(gh) => {
				gh.baseline('pkg-a', sha(4));
				gh.baseline('pkg-b', sha(2));
				gh.commit(sha(11), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/x.ts', 'packages/b/y.ts']);
			},
		);
		const result = await client.refreshPrStatuses();
		expect(result.entries[0]?.verdict).toMatchObject({
			applicable: ['pkg-a', 'pkg-b'],
			missing: ['pkg-a'],
		});
	});
});

/** An adapter that refuses any ancestry question about a commit that was not prepared for it. */
function strictAdapter(): { adapter: Ancestry; prepared: string[][]; preparedPulls: number[][] } {
	const prepared: string[][] = [];
	// Kept apart from `prepared`, which the guard reads: a refresh now prepares twice, the first with no PRs.
	const preparedPulls: number[][] = [];
	const known = new Set<string>();
	// The descendant of a question may be a PR head, which comes from the listing, not from `shas`.
	const guard = (commit: string): void => {
		if (prepared.length === 0) {
			throw new Error('ancestry asked before prepare');
		}
		if (!known.has(commit)) {
			throw new Error(`ancestry asked about ${commit} before it was prepared`);
		}
	};
	return {
		prepared,
		preparedPulls,
		adapter: {
			name: 'api',
			isAncestor(ancestor, descendant) {
				guard(ancestor);
				return Promise.resolve(ancestor <= descendant);
			},
			changedFiles(from) {
				guard(from);
				return Promise.resolve([]);
			},
			prepare(input) {
				prepared.push(input.shas);
				preparedPulls.push(input.pulls);
				for (const commit of input.shas) {
					known.add(commit);
				}
				for (const ref of input.refs) {
					if (ref.sha !== null) {
						known.add(ref.sha);
					}
				}
				return Promise.resolve({ heads: new Map() });
			},
		},
	};
}

/** A baseline at 3, one open PR containing it, and a merged labeled PR at 4. */
function orderingSetup(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	gh.commit(sha(11), [sha(4)]);
	gh.pull({ number: 1, headSha: sha(11) });
	gh.pull({
		number: 2,
		headSha: sha(4),
		state: 'closed',
		merged: true,
		labels: ['Require PR update'],
		mergeCommit: sha(4),
	});
}

describe('prepare ordering', () => {
	it('refresh prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({ written: 1 });
	});

	it('refresh-pr-status prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.refreshPrStatus({ sha: sha(11), report: true })).resolves.toMatchObject({
			verdict: { kind: 'pass' },
		});
	});

	it('report prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.report()).resolves.toMatchObject({ openPulls: 1 });
	});

	it('move-baseline prepares the target and then the labeled merge candidates', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.moveBaseline({ to: sha(5) })).resolves.toMatchObject({
			moves: [{ moved: true }],
		});
		expect(strict.prepared.some((shas) => shas.includes(sha(4)))).toBe(true);
	});

	it('rejects an online run without a token even with an injected adapter', () => {
		const strict = strictAdapter();
		expect(() => harness({ ancestryAdapter: strict.adapter, token: '' })).toThrow(
			/token is required/,
		);
	});
});

describe('prepare ordering after a lost race', () => {
	it('prepares the re-read baseline before asking about it', async () => {
		const strict = strictAdapter();
		const { client, github } = harness({ ancestryAdapter: strict.adapter }, (gh) =>
			gh.baseline('pr-baseline', sha(3)),
		);
		github.overrides.push({
			path: /\/git\/refs\/baselines\/pr-baseline/,
			method: 'PATCH',
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			if (response.status === 422) {
				github.baseline('pr-baseline', sha(4));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(strict.prepared.some((shas) => shas.includes(sha(4)))).toBe(true);
	});
});

describe('git failures after preparation', () => {
	it('end the refresh instead of failing every PR', async () => {
		let diffs = 0;
		const adapter: Ancestry = {
			name: 'git',
			isAncestor: () => Promise.resolve(true),
			changedFiles: () => {
				diffs++;
				return Promise.reject(new GitError(['diff'], 'fatal: unable to read tree', 128));
			},
			prepare: () => Promise.resolve({ heads: new Map() }),
		};
		const { client, github } = harness(
			{ ancestryAdapter: adapter, baselines: [{ name: 'pr-baseline', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(2)]);
				gh.commit(sha(12), [sha(2)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.pull({ number: 2, headSha: sha(12) });
			},
		);
		await expect(client.refreshPrStatuses()).rejects.toThrow(/unable to read tree/);
		expect(diffs).toBe(1);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});
});
