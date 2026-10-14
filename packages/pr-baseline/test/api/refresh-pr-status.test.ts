import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';

describe('refresh-pr-status', () => {
	it('passes a head that contains the baseline and writes the status once', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		const first = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(first.verdict.kind).toBe('pass');
		expect(first.written).toBe(true);
		expect(github.latestStatus(sha(10), 'PR baseline')).toMatchObject({
			state: 'success',
			description: 'Contains the required main changes.',
		});
		const second = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(second.skipped).toBe(true);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('fails a stale head and names the missing baselines', async () => {
		const { client, github } = harness(
			{
				baselines: [{ name: 'one' }, { name: 'two' }],
				targetUrl: 'https://docs.test/pr',
			},
			(gh) => {
				gh.baseline('one', sha(4));
				gh.baseline('two', sha(2));
				gh.commit(sha(10), [sha(3)]);
			},
		);
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('fail');
		expect(result.verdict.missing).toEqual(['one']);
		expect(github.latestStatus(sha(10), 'PR baseline')).toMatchObject({
			state: 'failure',
			description: 'Merge or rebase main to include: one',
			targetUrl: 'https://docs.test/pr',
		});
	});

	it('links a failing status to the compare view by default', async () => {
		const { client, github } = harness({ baselines: [{ name: 'one' }, { name: 'two' }] }, (gh) => {
			gh.baseline('one', sha(2));
			gh.baseline('two', sha(4));
			gh.commit(sha(10), [sha(3)]);
		});
		await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(github.latestStatus(sha(10), 'PR baseline')).toMatchObject({
			state: 'failure',
			targetUrl: `https://github.com/acme/widgets/compare/${sha(10)}...main`,
		});
		// The link names the branch, so a move leaves it alone and the failing status is not rewritten.
		github.baseline('two', sha(5));
		const again = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(again).toMatchObject({ written: false, skipped: true });
		expect(github.latestStatus(sha(10), 'PR baseline')?.targetUrl).toBe(
			`https://github.com/acme/widgets/compare/${sha(10)}...main`,
		);
	});

	it('rewrites a difference in wording alone, which the bulk refresh would leave', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(2));
			gh.commit(sha(10), [sha(3)]);
			gh.status(sha(10), { state: 'success', description: 'wording from an older release' });
		});
		// One write is cheap here and it is what stamps a PR after a push; only the sweep hoards them.
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result).toMatchObject({ written: true, skipped: false });
		expect(github.latestStatus(sha(10), 'PR baseline')?.description).toBe(
			'Contains the required main changes.',
		);
	});

	it('treats an absent baseline as satisfied', async () => {
		const { client } = harness({}, (gh) => gh.commit(sha(10), [sha(1)]));
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('pass');
		expect(result.baselines[0]?.sha).toBeNull();
	});

	it('peels an annotated tag', async () => {
		const { client } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3), true);
			gh.commit(sha(10), [sha(2)]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.baselines[0]?.sha).toBe(sha(3));
		expect(result.verdict.kind).toBe('fail');
	});

	it('posts a misconfiguration pass when the baseline left the base branch', async () => {
		const { client, warnings } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
			gh.commit(sha(10), [sha(5)]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('misconfigured');
		expect(result.verdict.status.state).toBe('success');
		expect(warnings.join('\n')).toContain('not on main');
	});

	it('rewrites a status another creator wrote', async () => {
		const { client } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.status(sha(10), {
				state: 'success',
				description: 'Contains the required main changes.',
				creator: 'old-app[bot]',
			});
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.written).toBe(true);
	});

	it('resolves a PR head and skips PRs against other branches by default', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.pull({ number: 7, headSha: sha(10) });
			gh.pull({ number: 8, headSha: sha(10), baseRef: 'release/1.x' });
		});
		const inScope = await client.refreshPrStatus({ pr: 7 });
		expect(inScope.sha).toBe(sha(10));
		expect(inScope.written).toBe(true);
		const outOfScope = await client.refreshPrStatus({ pr: 8 });
		expect(outOfScope.outOfScope).toBe(true);
		expect(outOfScope.written).toBe(false);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('writes a not-applicable pass for other bases when configured', async () => {
		const { client, github } = harness({ otherBases: 'pass' }, (gh) => {
			gh.commit(sha(10), [sha(4)]);
			gh.pull({ number: 8, headSha: sha(10), baseRef: 'release/1.x' });
		});
		const result = await client.refreshPrStatus({ pr: 8 });
		expect(result.outOfScope).toBe(true);
		expect(result.written).toBe(true);
		expect(github.latestStatus(sha(10), 'PR baseline')?.description).toBe(
			'Baseline applies to main only.',
		);
	});

	it('judges a stacked PR against the branch its stack lands on', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(4)]);
			gh.commit(sha(10), [sha(2)]);
			gh.pull({ number: 7, headSha: sha(11), stack: { id: 1, base: 'main', position: 1 } });
			gh.pull({
				number: 8,
				headSha: sha(10),
				baseRef: 'feature/a',
				stack: { id: 1, base: 'main', position: 2 },
			});
		});
		const result = await client.refreshPrStatus({ pr: 8 });
		expect(result).toMatchObject({ outOfScope: false, written: true });
		expect(result.verdict.kind).toBe('fail');
		expect(github.latestStatus(sha(10), 'PR baseline')?.description).toBe(
			'Merge or rebase main to include: pr-baseline',
		);
	});

	it('skips a stacked PR whose stack lands on another branch', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.commit(sha(10), [sha(4)]);
			gh.pull({
				number: 8,
				headSha: sha(10),
				baseRef: 'feature/a',
				stack: { id: 1, base: 'release/1.x', position: 2 },
			});
		});
		await expect(client.refreshPrStatus({ pr: 8 })).resolves.toMatchObject({
			outOfScope: true,
			written: false,
		});
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('uses the PR base on a server without stacks', async () => {
		const { client } = harness({}, (gh) => {
			gh.stacks = false;
			gh.commit(sha(10), [sha(4)]);
			gh.pull({
				number: 8,
				headSha: sha(10),
				baseRef: 'feature/a',
				stack: { id: 1, base: 'main', position: 2 },
			});
		});
		await expect(client.refreshPrStatus({ pr: 8 })).resolves.toMatchObject({ outOfScope: true });
	});

	it('re-reads the baseline refs before posting and evaluates against the moved baseline', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(2));
			gh.commit(sha(10), [sha(3)]);
		});
		let reads = 0;
		const original = github.fetch;
		// The second ref read sees a move; the verdict must be computed against the new commit.
		github.fetch = async (input, init) => {
			const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
			if (url.includes('/git/ref/baselines/pr-baseline') && ++reads === 2) {
				github.baseline('pr-baseline', sha(4));
			}
			return original(input, init);
		};
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('fail');
		expect(result.baselines[0]?.sha).toBe(sha(4));
		expect(github.requests(/compare\/0+4\.\.\.0+a\?/)).toHaveLength(1);
	});

	it('does not write for a bare ref unless asked', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.branch('feature', sha(10));
		});
		const quiet = await client.refreshPrStatus({ sha: 'feature' });
		expect(quiet.sha).toBe(sha(10));
		expect(quiet.written).toBe(false);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		const loud = await client.refreshPrStatus({ sha: 'feature', report: true });
		expect(loud.written).toBe(true);
	});

	it('applies scoped baselines only when the PR diff touches the scope', async () => {
		const { client } = harness(
			{
				baselines: [
					{ name: 'repo' },
					{ name: 'pkg-a', scope: ['packages/a/'] },
					{ name: 'pkg-b', scope: ['packages/b/'] },
				],
			},
			(gh) => {
				gh.baseline('repo', sha(2));
				gh.baseline('pkg-a', sha(4));
				gh.baseline('pkg-b', sha(4));
				gh.commit(sha(10), [sha(3)]);
				gh.files.set(`${sha(5)}...${sha(10)}`, ['packages/a/index.ts', 'README.md']);
			},
		);
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.applicable).toEqual(['repo', 'pkg-a']);
		expect(result.verdict.missing).toEqual(['pkg-a']);
	});

	it('binds every scoped baseline when the diff is indeterminate', async () => {
		const { client, warnings } = harness(
			{ baselines: [{ name: 'pkg-a', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('pkg-a', sha(4));
				gh.commit(sha(10), [sha(3)]);
				gh.files.set(
					`${sha(5)}...${sha(10)}`,
					Array.from({ length: 300 }, (_, index) => `other/${index}.ts`),
				);
			},
		);
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.applicable).toEqual(['pkg-a']);
		expect(result.verdict.kind).toBe('fail');
		expect(warnings.join('\n')).toContain('indeterminate');
	});

	it('rejects an unknown PR as a configuration error', async () => {
		const { client } = harness();
		await expect(client.refreshPrStatus({ pr: 99 })).rejects.toThrow(/not found/);
	});
});

describe('refresh-pr-status guards', () => {
	it('posts the misconfiguration pass even when the commit contains the off-base baseline', async () => {
		const { client } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
			gh.commit(sha(10), [sha(20)]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('misconfigured');
		expect(result.verdict.status.description).toContain('pr-baseline not on main');
	});

	it('resolves the creator before evaluating anything when reporting', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.user = null;
		});
		await expect(client.refreshPrStatus({ sha: sha(10), report: true })).rejects.toThrow(
			/--creator/,
		);
		// The baseline refs are read for the result, but no ancestry is evaluated before the creator is known.
		expect(github.requests(/compare/)).toHaveLength(0);
	});

	it('fails on a creator mismatch reported by the write', async () => {
		const { client, github } = harness({ creator: 'expected[bot]' }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		await expect(client.refreshPrStatus({ sha: sha(10), report: true })).rejects.toThrow(
			/expected\[bot\]/,
		);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('peels a tag that points at another tag object', async () => {
		const { client } = harness({}, (gh) => {
			gh.refs.set('refs/baselines/pr-baseline', { type: 'tag', sha: 'outer', peeled: sha(3) });
			gh.nestedTags.set('outer', { type: 'tag', sha: 'inner' });
			gh.nestedTags.set('inner', { type: 'commit', sha: sha(3) });
			gh.commit(sha(10), [sha(2)]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.baselines[0]?.sha).toBe(sha(3));
		expect(result.verdict.kind).toBe('fail');
	});

	it('counts a renamed file under both names for scope matching', async () => {
		const { client } = harness({ baselines: [{ name: 'pkg-a', scope: ['packages/a/'] }] }, (gh) => {
			gh.baseline('pkg-a', sha(4));
			gh.commit(sha(10), [sha(3)]);
			gh.renames.set(`${sha(5)}...${sha(10)}`, [['packages/a/old.ts', 'packages/b/new.ts']]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.applicable).toEqual(['pkg-a']);
	});

	it('rejects a commit together with --pr', async () => {
		const { client } = harness();
		await expect(client.refreshPrStatus({ sha: sha(5), pr: 1 })).rejects.toThrow(
			/either a commit or --pr/,
		);
	});
});

describe('refresh-pr-status tag objects', () => {
	it('rejects a tag that resolves to a tree', async () => {
		const { client } = harness({}, (gh) => {
			gh.refs.set('refs/baselines/pr-baseline', { type: 'tag', sha: 'outer', peeled: sha(3) });
			gh.nestedTags.set('outer', { type: 'tree' as 'commit', sha: 'treesha' });
			gh.commit(sha(10), [sha(2)]);
		});
		await expect(client.refreshPrStatus({ sha: sha(10), report: true })).rejects.toThrow(
			/points at a tree/,
		);
	});
});

describe('refresh-pr-status round 3', () => {
	it('does not write for a full SHA unless asked', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		const result = await client.refreshPrStatus({ sha: sha(10) });
		expect(result.verdict.kind).toBe('pass');
		expect(result.written).toBe(false);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('judges a baseline that advanced with the base against the new head', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		let reads = 0;
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
			// Base and baseline both advance to a new commit 6 during the second ref read.
			if (url.includes('/git/ref/baselines/pr-baseline') && ++reads === 2) {
				github.commit(sha(6), [sha(5)]);
				github.branch('main', sha(6));
				github.baseline('pr-baseline', sha(6));
			}
			return original(input, init);
		};
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('fail');
		expect(github.latestStatus(sha(10), 'PR baseline')?.state).toBe('failure');
	});

	it('returns the resolved baselines for an out-of-scope PR', async () => {
		const { client } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.pull({ number: 8, headSha: sha(10), baseRef: 'release/1.x' });
		});
		const result = await client.refreshPrStatus({ pr: 8 });
		expect(result.outOfScope).toBe(true);
		expect(result.baselines).toEqual([
			{ name: 'pr-baseline', label: 'Require PR update', sha: sha(3) },
		]);
	});

	it('requests a nested baseline ref with the slash percent-encoded', async () => {
		const { client, github } = harness({ baselines: [{ name: 'baseline/web' }] }, (gh) => {
			gh.baseline('baseline/web', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		await client.refreshPrStatus({ sha: sha(10) });
		expect(
			github.calls.some((call) => call.rawPath.endsWith('/git/ref/baselines%2Fbaseline%2Fweb')),
		).toBe(true);
	});
});

describe('refresh-pr-status validation order', () => {
	it('rejects a commit with --pr before any request', async () => {
		const { client, github } = harness();
		await expect(client.refreshPrStatus({ sha: sha(5), pr: 1 })).rejects.toThrow(
			/either a commit or --pr/,
		);
		expect(github.calls).toHaveLength(0);
	});

	it('rejects a cycle of tag objects', async () => {
		const { client } = harness({}, (gh) => {
			gh.refs.set('refs/baselines/pr-baseline', { type: 'tag', sha: 'outer', peeled: sha(3) });
			gh.nestedTags.set('outer', { type: 'tag', sha: 'inner' });
			gh.nestedTags.set('inner', { type: 'tag', sha: 'outer' });
			gh.commit(sha(10), [sha(2)]);
		});
		await expect(client.refreshPrStatus({ sha: sha(10) })).rejects.toThrow(/cycle/);
	});
});

describe('refresh-pr-status round 7', () => {
	it('judges a move landing between the ref read and the head read against the new refs', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
		});
		let refReads = 0;
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
			const response = await original(input, init);
			// The second ref read has answered with commit 3; both refs then advance before the head read.
			if (url.includes('/git/ref/baselines/pr-baseline') && ++refReads === 2) {
				github.commit(sha(6), [sha(5)]);
				github.branch('main', sha(6));
				github.baseline('pr-baseline', sha(6));
			}
			return response;
		};
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.verdict.kind).toBe('fail');
		expect(result.baselines[0]?.sha).toBe(sha(6));
		expect(github.latestStatus(sha(10), 'PR baseline')?.state).toBe('failure');
	});

	it('skips an out-of-scope PR without needing a resolvable creator', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			gh.user = null;
			gh.commit(sha(10), [sha(4)]);
			gh.pull({ number: 8, headSha: sha(10), baseRef: 'release/1.x' });
		});
		const result = await client.refreshPrStatus({ pr: 8 });
		expect(result.outOfScope).toBe(true);
		expect(github.requests(/\/user$/)).toHaveLength(0);
	});

	it('retries a transient failure of the status write', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(10), [sha(4)]);
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 503, times: 2 });
		});
		const result = await client.refreshPrStatus({ sha: sha(10), report: true });
		expect(result.written).toBe(true);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});
});
