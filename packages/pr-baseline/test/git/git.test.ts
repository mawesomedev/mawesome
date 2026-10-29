import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo, type GitRepo } from '../../src/git/repo.ts';
import { createApiClient } from '../../src/github/api.ts';
import { createClient, type Client, type ClientOptions } from '../../src/index.ts';
import { createLeaseRefWriter } from '../../src/ref-writer.ts';
import { FakeGitHub } from '@mawesome/testing/github';
import { GitFixture } from '../helpers/git-repo.ts';

interface World {
	fixture: GitFixture;
	github: FakeGitHub;
	logs: string[];
	warnings: string[];
	/** main: c1 -> c2 -> c3 (baseline) -> c4 (head). */
	c: string[];
}

let world: World;

/** Builds the base branch, seeds the fake with the same commits, and clones treelessly. */
function build(): World {
	const fixture = new GitFixture();
	const c1 = fixture.commit('one', { 'README.md': 'one' });
	const c2 = fixture.commit('two', { 'packages/a/index.ts': 'a' });
	const c3 = fixture.commit('three', { '.nvmrc': '24' });
	const c4 = fixture.commit('four', { 'docs/guide.md': 'g' });
	fixture.push('main', 'refs/heads/main');
	fixture.baseline('pr-baseline', c3);
	fixture.clone();
	const github = new FakeGitHub();
	fixture.mirror(github);
	github.baseline('pr-baseline', c3);
	// The API and the remote are one server in reality: API writes land on the remote, and reads come from it.
	github.onRefWrite = (ref, sha) => fixture.push(sha, ref);
	github.refSource = (ref) => fixture.remoteRef(ref);
	github.tagSource = (sha) => fixture.remoteTagObject(sha);
	return { fixture, github, logs: [], warnings: [], c: [c1, c2, c3, c4] };
}

function client(options: ClientOptions = {}): Client {
	return createClient({
		repo: world.github.repo,
		token: 'test-token',
		fetch: (input, init) => world.github.fetch(input, init),
		logger: {
			info: (message) => world.logs.push(message),
			warn: (message) => world.warnings.push(message),
		},
		sleep: () => Promise.resolve(),
		retryBaseMs: 0,
		tokenIsWorkflowToken: true,
		gitDir: world.fixture.cloneDir,
		// These cases predate scoping and assert the full sweep.
		scope: 'all',
		env: {},
		...options,
	});
}

/** A PR branch off `from` with one commit; registered in the remote and the fake. */
function openPull(number: number, from: string, files: Record<string, string | null>): string {
	world.fixture.checkout(from, `pr-${number}`);
	const head = world.fixture.commit(`pr ${number}`, files);
	world.fixture.checkout('main');
	world.fixture.pull(number, head);
	world.github.commit(head, [from]);
	world.github.pull({ number, headSha: head });
	return head;
}

/** A new commit off `parent` on PR `number`'s branch: the remote serves it and the API reports it, but the pull ref stays put. */
function laggingHead(number: number, parent: string, files: Record<string, string | null>): string {
	world.fixture.checkout(parent, `pr-${number}-${parent.slice(0, 8)}`);
	const head = world.fixture.commit(`pr ${number} lagging`, files);
	world.fixture.checkout('main');
	world.fixture.push(head, `refs/heads/pr-${number}`);
	world.github.commit(head, [parent]);
	const pull = world.github.pulls.get(number);
	if (pull) {
		pull.headSha = head;
	}
	return head;
}

/** Points the API's head for PR `number` at a commit the remote has never had. */
function unservedHead(number: number): void {
	const pull = world.github.pulls.get(number);
	if (pull) {
		pull.headSha = 'e'.repeat(39) + String(number);
	}
}

beforeEach(() => {
	world = build();
});

afterEach(() => {
	world.fixture.cleanup();
});

describe('git ancestry', () => {
	it('is selected automatically for a clone of the repository and answers without compare calls', async () => {
		const [, c2, , c4] = world.c;
		const stale = openPull(1, c2 as string, { 'x.txt': 'x' });
		const fresh = openPull(2, c4 as string, { 'y.txt': 'y' });
		const result = await client().refreshPrStatuses();
		expect(result.ancestry).toBe('git');
		expect(result).toMatchObject({
			written: 2,
			skipped: 0,
			closed: 0,
			deferred: 0,
			incomplete: false,
		});
		expect(world.github.latestStatus(stale, 'PR baseline')?.state).toBe('failure');
		expect(world.github.latestStatus(fresh, 'PR baseline')?.state).toBe('success');
		expect(world.github.requests(/compare/)).toHaveLength(0);
		expect(world.logs.some((line) => line.includes('Fetched 2 PR heads'))).toBe(true);
	});

	it('falls back to the API when the clone serves another repository', async () => {
		const other = new FakeGitHub({ repo: 'someone/else' });
		other.chain(1, 3);
		other.branch('main', '0'.repeat(39) + '3');
		const fallback = createClient({
			repo: other.repo,
			token: 't',
			fetch: (input, init) => other.fetch(input, init),
			gitDir: world.fixture.cloneDir,
			tokenIsWorkflowToken: true,
			env: {},
			logger: { info() {}, warn() {} },
		});
		const result = await fallback.report();
		expect(result.ancestry).toBe('api');
		await expect(
			createClient({
				repo: other.repo,
				token: 't',
				fetch: (input, init) => other.fetch(input, init),
				gitDir: world.fixture.cloneDir,
				ancestry: 'git',
				env: {},
				logger: { info() {}, warn() {} },
			}).report(),
		).rejects.toThrow(/does not have someone\/else/);
	});

	it('counts a closed PR as closed and a moving one as deferred', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.deletePull(1);
		const closing = world.github.pulls.get(1);
		if (closing) {
			closing.state = 'closed';
		}
		const moving = openPull(2, c2 as string, { 'y.txt': 'y' });
		// The listing still shows the old head; the remote already has a newer one, and the API another.
		world.fixture.checkout(`pr-2`);
		const newer = world.fixture.commit('newer', { 'y.txt': 'yy' });
		world.fixture.checkout('main');
		world.fixture.pull(2, newer);
		world.github.commit(newer, [moving]);
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/pulls/2')) {
				const pull = world.github.pulls.get(2);
				if (pull) {
					pull.headSha = 'f'.repeat(40);
				}
			}
			return original(input, init);
		};
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({
			closed: 0,
			deferred: 1,
			written: 0,
			incomplete: true,
			paused: false,
			reason: 'deferred',
		});
		expect(result.entries.map((entry) => [entry.number, entry.outcome])).toEqual([[2, 'deferred']]);
	});

	it('evaluates a PR at its new head when the remote and the API agree on it', async () => {
		const [, c2, , c4] = world.c;
		const first = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.checkout('pr-1');
		world.fixture.git(world.fixture.workDir, ['merge', '--quiet', '--no-edit', c4 as string]);
		const merged = world.fixture.git(world.fixture.workDir, ['rev-parse', 'HEAD']).trim();
		world.fixture.checkout('main');
		world.fixture.pull(1, merged);
		world.github.commit(merged, [first, c4 as string]);
		// The listing is stale (old head) but the PR itself now reports the merged head, like the remote.
		const listing = world.github.pulls.get(1);
		if (listing) {
			listing.headSha = merged;
		}
		world.github.pageSize = 100;
		const result = await client().refreshPrStatuses();
		expect(result.entries[0]).toMatchObject({ number: 1, sha: merged, outcome: 'written' });
		expect(world.github.latestStatus(merged, 'PR baseline')?.state).toBe('success');
	});

	it('refuses when the remote baseline ref disagrees with the API', async () => {
		const [, c2, , c4] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		world.github.refSource = undefined;
		world.github.baseline('pr-baseline', c4 as string);
		await expect(client().refreshPrStatuses()).rejects.toThrow(
			/differs between the API and the remote/,
		);
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('scopes baselines through git diffs, including renames, deletions and odd names', async () => {
		const [, c2, c3] = world.c;
		const head = openPull(1, c2 as string, {
			'packages/a/index.ts': null,
			'packages/b/index.ts': 'a',
			'docs/with space.md': 's',
		});
		const result = await client({
			baselines: [
				{ name: 'pr-baseline', scope: ['packages/a/'] },
				{ name: 'absent', scope: ['docs/'] },
				{ name: 'untouched', scope: ['apps/'] },
			],
		}).refreshPrStatus({ sha: head });
		expect(result.ancestry).toBe('git');
		expect(result.verdict.applicable).toEqual(['pr-baseline', 'absent']);
		expect(result.verdict.missing).toEqual(['pr-baseline']);
		expect(result.baselines[0]?.sha).toBe(c3);
	});

	it('moves on a marker change detected through git and refreshes', async () => {
		const [, c2, , c4] = world.c;
		world.github.baseline('pr-baseline', c2 as string);
		world.fixture.baseline('pr-baseline', c2 as string);
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const result = await client({
			baselines: [{ name: 'pr-baseline', markers: ['.nvmrc'] }],
		}).moveBaseline({ refreshPrStatuses: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: c2, to: c4, reason: 'markers' });
		expect(result.refresh).toMatchObject({ written: 1 });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('reports stale and current counts', async () => {
		const [, c2, , c4] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		const fresh = openPull(2, c4 as string, { 'y.txt': 'y' });
		world.github.status(fresh, {
			state: 'success',
			description: 'Contains the required main changes.',
		});
		const result = await client().report();
		expect(result).toMatchObject({ ancestry: 'git', openPulls: 2, stale: 1, current: 1 });
		// The four listing buckets are reported under this adapter too, and partition the open PRs.
		expect(result).toMatchObject({ passing: 1, failing: 0, other: 0, unstamped: 1 });
		expect(result.passing + result.failing + result.other + result.unstamped).toBe(
			result.openPulls,
		);
	});

	it('counts a wording-only difference as cosmetic rather than stale', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.github.status(head, {
			state: 'failure',
			description: 'wording from an older release',
			targetUrl: `https://github.com/acme/widgets/compare/${head}...main`,
		});
		// The refresh skips it on purpose, so counting it stale would mean the number never reaches zero.
		expect(await client().report()).toMatchObject({ stale: 0, cosmetic: 1, current: 0 });
	});

	it('counts a failing status with the default link as current, and the refresh skips it', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.github.status(head, {
			state: 'failure',
			description: 'Merge or rebase main to include: pr-baseline',
			targetUrl: `https://github.com/acme/widgets/compare/${head}...main`,
		});
		expect(await client().report()).toMatchObject({ stale: 0, current: 1 });
		expect(await client().refreshPrStatuses()).toMatchObject({ written: 0, skipped: 1 });
	});

	it("evaluates a local commit offline against the clone's baseline refs", async () => {
		const [, c2] = world.c;
		world.fixture.checkout(c2 as string, 'local');
		const head = world.fixture.commit('local work', { 'z.txt': 'z' });
		world.fixture.checkout('main');
		world.fixture.push('local', 'refs/heads/local');
		// A clone never fetches the baseline namespace by itself; offline use needs this explicit refspec.
		world.fixture.git(world.fixture.cloneDir, [
			'fetch',
			'--quiet',
			'origin',
			'refs/heads/local:refs/heads/local',
			'+refs/baselines/*:refs/baselines/*',
		]);
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		const result = await offline.refreshPrStatus({ sha: head });
		expect(result.verdict.kind).toBe('fail');
		expect(result.base).toBe('main');
		expect(world.github.calls).toHaveLength(0);
	});
});

describe('git ancestry review round 2', () => {
	it('never uses a shallow clone: auto falls back to the API, git fails with instructions', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.shallowClone();
		const result = await client().refreshPrStatuses();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('shallow');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/fetch-depth: 0/);
	});

	it('accepts a baseline ref pointing at a tag object whose peeled commit matches the API', async () => {
		const [, c2, c3] = world.c;
		world.fixture.baseline('pr-baseline', c3 as string, true);
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, failed: 0 });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('refuses when the API knows a baseline the remote lacks, and the other way round', async () => {
		const [, c2, c3] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		world.github.refSource = undefined;
		world.github.baseline('extra', c3 as string);
		await expect(
			client({ baselines: [{ name: 'pr-baseline' }, { name: 'extra' }] }).refreshPrStatuses(),
		).rejects.toThrow(/Baseline extra differs/);
		world.github.refs.delete('refs/baselines/pr-baseline');
		await expect(client().refreshPrStatuses()).rejects.toThrow(/Baseline pr-baseline differs/);
	});

	it("stamps a reconciled new head instead of trusting the old head's status", async () => {
		const [, c2, , c4] = world.c;
		const old = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.github.status(old, {
			state: 'failure',
			description: 'Merge or rebase main to include: pr-baseline',
		});
		// The PR is rebased onto the base head; the remote and the PR endpoint know, the listing does not.
		world.fixture.checkout(c4 as string, 'rebased');
		const rebased = world.fixture.commit('pr 1 rebased', { 'x.txt': 'x' });
		world.fixture.checkout('main');
		world.fixture.pull(1, rebased);
		world.github.commit(rebased, [c4 as string]);
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/pulls/1')) {
				const pull = world.github.pulls.get(1);
				if (pull) {
					pull.headSha = rebased;
				}
			}
			return original(input, init);
		};
		const result = await client().refreshPrStatuses();
		expect(result.entries[0]).toMatchObject({ number: 1, sha: rebased, outcome: 'written' });
		expect(world.github.latestStatus(rebased, 'PR baseline')?.state).toBe('success');
	});

	it('runs a dry-run move and refresh of a present baseline against the real, unmoved ref', async () => {
		const [, c2, c3, c4] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const result = await client({ dryRun: true }).moveBaseline({
			force: true,
			refreshPrStatuses: true,
		});
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4 });
		expect(result.refresh).toMatchObject({ written: 1, dryRun: true });
		expect(world.github.baselineAt('pr-baseline')).toBe(c3);
		expect(world.github.latestStatus(head, 'PR baseline')).toBeNull();
	});

	it('handles unrelated histories and a head shared by two PRs', async () => {
		const [, c2] = world.c;
		world.fixture.git(world.fixture.workDir, ['checkout', '--quiet', '--orphan', 'orphan']);
		world.fixture.git(world.fixture.workDir, ['rm', '-rfq', '.']);
		const orphan = world.fixture.commit('unrelated', { 'o.txt': 'o' });
		world.fixture.checkout('main');
		world.fixture.pull(1, orphan);
		world.github.commit(orphan, []);
		world.github.pull({ number: 1, headSha: orphan });
		const shared = openPull(2, c2 as string, { 'x.txt': 'x' });
		world.fixture.pull(3, shared);
		world.github.pull({ number: 3, headSha: shared });
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 2, skipped: 1, failed: 0 });
		expect(world.github.latestStatus(orphan, 'PR baseline')?.state).toBe('failure');
		expect(world.github.requests(new RegExp(`/statuses/${shared}`), 'POST')).toHaveLength(1);
	});

	it('ignores a stale local baseline ref when the API and the remote agree on a newer one', async () => {
		const [, c2, , c4] = world.c;
		world.fixture.git(world.fixture.cloneDir, [
			'update-ref',
			'refs/baselines/pr-baseline',
			c2 as string,
		]);
		world.fixture.baseline('pr-baseline', c4 as string);
		world.github.baseline('pr-baseline', c4 as string);
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const result = await client().refreshPrStatus({ sha: head, report: true });
		expect(result.baselines[0]?.sha).toBe(c4);
		expect(result.verdict.kind).toBe('fail');
	});

	it('matches a filename containing a newline through the git diff', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'docs/odd\nname.md': 'n' });
		const result = await client({
			baselines: [{ name: 'pr-baseline', scope: ['docs/'] }],
		}).refreshPrStatus({
			sha: head,
		});
		expect(result.verdict.applicable).toEqual(['pr-baseline']);
	});

	it('rejects offline for every command but refresh-pr-status, and reads a slashed default branch offline', async () => {
		const [, , , c4] = world.c;
		world.fixture.checkout(c4 as string, 'release/v1');
		world.fixture.push('release/v1', 'refs/heads/release/v1');
		world.fixture.setDefaultBranch('release/v1');
		world.fixture.clone();
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		await expect(offline.refreshPrStatuses()).rejects.toThrow(
			/--offline applies to refresh-pr-status only/,
		);
		await expect(offline.report()).rejects.toThrow(/--offline applies to refresh-pr-status only/);
		await expect(offline.moveBaseline()).rejects.toThrow(
			/--offline applies to refresh-pr-status only/,
		);
		const result = await offline.refreshPrStatus({ sha: c4 as string });
		expect(result.base).toBe('release/v1');
		expect(result.verdict.kind).toBe('pass');
		expect(() =>
			createClient({
				repo: 'a/b',
				offline: true,
				ancestry: 'api',
				env: {},
				logger: { info() {}, warn() {} },
			}),
		).toThrow(/--offline needs git ancestry/);
	});
});

describe('git ancestry review round 3', () => {
	it('notices a PR that closed during the fetch although its pull ref survived', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		let listings = 0;
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const response = await original(input, init);
			const url = String(input instanceof Request ? input.url : input);
			// The PR closes right after the first listing; GitHub keeps refs/pull/1/head anyway.
			if (url.endsWith('/graphql') && ++listings === 1) {
				const pull = world.github.pulls.get(1);
				if (pull) {
					pull.state = 'closed';
				}
			}
			return response;
		};
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ closed: 1, written: 0, incomplete: false });
		expect(world.github.latestStatus(head, 'PR baseline')).toBeNull();
	});

	it('evaluates a PR whose pull ref is gone while both API reads agree on its head', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.deletePull(1);
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, deferred: 0, closed: 0, incomplete: false });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('calls a deferral a failure even when a budget stopped the run', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		openPull(2, c2 as string, { 'y.txt': 'y' });
		openPull(3, c2 as string, { 'z.txt': 'z' });
		unservedHead(3);
		const result = await client({ maxWritesPerRun: 1 }).refreshPrStatuses();
		// The cap would be a pause on its own; the deferred PR is what keeps the run a failure.
		expect(result).toMatchObject({
			written: 1,
			deferred: 1,
			incomplete: true,
			paused: false,
			reason: 'write-cap',
		});
	});

	it('calls a deferral a failure even when the run wrote everything else', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		openPull(2, c2 as string, { 'y.txt': 'y' });
		unservedHead(2);
		const result = await client().refreshPrStatuses();
		// The deferred PR's next head is unstamped, so no later run revisits it on its own.
		expect(result).toMatchObject({
			written: 1,
			deferred: 1,
			incomplete: true,
			paused: false,
			reason: 'deferred',
		});
	});

	it('binds a report on the fetched head when the listed one is gone from the remote', async () => {
		const [, c2, , c4] = world.c;
		const old = openPull(1, c2 as string, { 'packages/a/x.ts': 'x' });
		world.fixture.checkout(c4 as string, 'replacement');
		const replacement = world.fixture.commit('replacement', { 'docs/y.md': 'y' });
		world.fixture.checkout('main');
		world.fixture.pull(1, replacement);
		world.github.commit(replacement, [c4 as string]);
		// The listing still names the old head, which is unreachable from the remote now.
		void old;
		const result = await client({
			baselines: [
				{ name: 'pr-baseline', scope: ['packages/a/'] },
				{ name: 'docs', scope: ['docs/'] },
			],
		}).report();
		expect(result.baselines.map((baseline) => [baseline.name, baseline.bound])).toEqual([
			['pr-baseline', 0],
			['docs', 1],
		]);
		expect(result.stale).toBe(1);
	});

	it('binds every scoped baseline to a head with unrelated history', async () => {
		world.fixture.git(world.fixture.workDir, ['checkout', '--quiet', '--orphan', 'orphan']);
		world.fixture.git(world.fixture.workDir, ['rm', '-rfq', '.']);
		const orphan = world.fixture.commit('unrelated', { 'o.txt': 'o' });
		world.fixture.checkout('main');
		world.fixture.pull(1, orphan);
		world.github.commit(orphan, []);
		world.github.pull({ number: 1, headSha: orphan });
		const result = await client({
			baselines: [{ name: 'pr-baseline', scope: ['packages/a/'] }],
		}).refreshPrStatuses();
		expect(result.entries[0]?.verdict).toMatchObject({ applicable: ['pr-baseline'], kind: 'fail' });
		expect(world.warnings.join('\n')).toContain('indeterminate');
	});

	it('keeps an offline refresh-pr-status local: no --pr, no report, no unresolved ref, no fetch', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		await expect(offline.refreshPrStatus({ pr: 1 })).rejects.toThrow(/local only/);
		await expect(offline.refreshPrStatus({ sha: head, report: true })).rejects.toThrow(
			/local only/,
		);
		await expect(offline.refreshPrStatus({ sha: 'no-such-ref' })).rejects.toThrow(
			/does not resolve in the clone/,
		);
		// The PR head was never fetched into the clone and offline must not fetch it.
		await expect(offline.refreshPrStatus({ sha: head })).rejects.toThrow();
		expect(world.github.calls).toHaveLength(0);
	});
});

describe('git ancestry review round 4', () => {
	it('fails offline on a local baseline ref that is not a commit instead of passing it as absent', async () => {
		const [, c2] = world.c;
		// A baseline ref pointing at a tree, pushed from the work tree; the treeless clone gets the ref but not the object.
		const tree = world.fixture.git(world.fixture.workDir, ['rev-parse', `${c2}^{tree}`]).trim();
		world.github.refSource = undefined;
		world.fixture.baseline('pr-baseline', tree);
		world.fixture.git(world.fixture.cloneDir, [
			'fetch',
			'--quiet',
			'--filter=tree:0',
			'origin',
			'+refs/baselines/pr-baseline:refs/baselines/pr-baseline',
		]);
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		await expect(offline.refreshPrStatus({ sha: c2 as string })).rejects.toThrow(
			/does not resolve to a commit/,
		);
	});
});

describe('git ancestry review round 5', () => {
	it('rejects an offline evaluation of a full SHA the clone does not have, even with an absent baseline', async () => {
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			baselines: [{ name: 'absent' }],
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		await expect(offline.refreshPrStatus({ sha: '1'.repeat(40) })).rejects.toThrow(
			/not in the clone/,
		);
	});

	it('requires a token for an online run even with a usable clone', async () => {
		// The requirement is enforced when the client is created, before any adapter is chosen.
		expect(() => client({ token: '' })).toThrow(/token is required/);
	});

	it('warns when a repository is present but unusable', async () => {
		const other = new FakeGitHub({ repo: 'someone/else' });
		other.chain(1, 3);
		other.branch('main', '0'.repeat(39) + '3');
		const warnings: string[] = [];
		await createClient({
			repo: other.repo,
			token: 't',
			fetch: (input, init) => other.fetch(input, init),
			gitDir: world.fixture.cloneDir,
			tokenIsWorkflowToken: true,
			env: {},
			logger: { info() {}, warn: (message) => warnings.push(message) },
		}).report();
		expect(warnings.join('\n')).toContain('does not serve someone/else');
	});
});

describe('git ancestry review round 6', () => {
	it('never adopts a clone whose http origin is another host, so the token stays home', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'https://evil.example/acme/widgets.git',
		]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('does not serve acme/widgets');
	});

	it('counts a PR retargeted or turned draft during preparation as out of scope', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		openPull(2, c2 as string, { 'y.txt': 'y' });
		let listings = 0;
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const response = await original(input, init);
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/graphql') && ++listings === 1) {
				const first = world.github.pulls.get(1);
				const second = world.github.pulls.get(2);
				if (first) {
					first.baseRef = 'release/1.x';
				}
				if (second) {
					second.isDraft = true;
				}
			}
			return response;
		};
		const result = await client({ includeDrafts: false }).refreshPrStatuses();
		expect(result).toMatchObject({ outOfScope: 2, closed: 0, written: 0, incomplete: false });
		expect(result.entries.map((entry) => entry.outcome)).toEqual(['out-of-scope', 'out-of-scope']);
	});
});

describe('git ancestry hardening', () => {
	it('refuses a remote with remote.origin.vcs set', async () => {
		world.fixture.git(world.fixture.cloneDir, ['config', 'remote.origin.vcs', 'evil']);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('does not serve');
	});

	it('runs no hooks and keeps the token out of their reach', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		const marker = `${world.fixture.root}/hook-ran`;
		const hooks = `${world.fixture.cloneDir}/.git/hooks`;
		world.fixture.git(world.fixture.cloneDir, ['config', 'core.hooksPath', hooks]);
		writeFileSync(`${hooks}/reference-transaction`, `#!/bin/sh\nenv > ${marker}\n`, {
			mode: 0o755,
		});
		const result = await client().refreshPrStatuses();
		expect(result.written).toBe(1);
		expect(existsSync(marker)).toBe(false);
	});

	it('ignores replacement objects and refuses grafts', async () => {
		const [c1, c2, c3] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		// A local replacement that makes the PR head look like it descends from the baseline.
		world.fixture.git(world.fixture.cloneDir, [
			'fetch',
			'--quiet',
			'--filter=tree:0',
			'origin',
			'refs/pull/1/head',
		]);
		world.fixture.git(world.fixture.cloneDir, ['replace', '--graft', head, c3 as string]);
		const honest = await client().refreshPrStatus({ sha: head });
		expect(honest.verdict.kind).toBe('fail');
		writeFileSync(`${world.fixture.cloneDir}/.git/info/grafts`, `${c2} ${c1}\n`);
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/grafts/);
		const fallback = await client().report();
		expect(fallback.ancestry).toBe('api');
	});
});

describe('git ancestry review round 9', () => {
	it('refuses a clone with a second promisor remote', async () => {
		world.fixture.git(world.fixture.cloneDir, ['config', 'remote.evil.url', 'evil_helper::/tmp/x']);
		world.fixture.git(world.fixture.cloneDir, ['config', 'remote.evil.promisor', 'true']);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('promisor remote other than');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/promisor remote/);
	});

	it('falls back to the API in auto when the clone cannot fetch, and keeps git when told to', async () => {
		const [, c2] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		rmSync(world.fixture.remoteDir, { recursive: true, force: true });
		world.github.refSource = undefined;
		const result = await client().refreshPrStatuses();
		expect(result.ancestry).toBe('api');
		expect(result.written).toBe(1);
		expect(world.warnings.join('\n')).toContain('falling back to API ancestry');
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
		await expect(client({ ancestry: 'git' }).refreshPrStatuses()).rejects.toThrow();
	});
});

describe('git ancestry review round 10', () => {
	it.each([
		['yes', 'promisor'],
		['ON', 'promisor'],
		['1', 'promisor'],
		['tree:0', 'partialclonefilter'],
	])('refuses a second promisor identity spelled %s in %s', async (value, key) => {
		world.fixture.git(world.fixture.cloneDir, ['config', 'remote.evil.url', 'evil_helper::/tmp/x']);
		world.fixture.git(world.fixture.cloneDir, ['config', `remote.evil.${key}`, value]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('promisor remote other than');
	});

	it('refuses a clone with a URL rewrite rule', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'url.ext::sh -c evil.insteadOf',
			world.fixture.remoteUrl,
		]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('does not serve');
	});
});

describe('git ancestry review round 11', () => {
	it.each([
		['http.https://github.com/.proxy', 'http://evil.example:8080'],
		['http.sslVerify', 'false'],
		['http.https://github.com/acme/widgets/.curloptResolve', 'github.com:443:203.0.113.5'],
	])('refuses a clone with a local %s setting', async (key, value) => {
		world.fixture.git(world.fixture.cloneDir, ['config', key, value]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
	});

	it('tolerates a persisted extraheader in the clone', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'http.https://github.com/.extraheader',
			'AUTHORIZATION: basic old',
		]);
		const result = await client().report();
		expect(result.ancestry).toBe('git');
	});

	it.each([
		['a second fetch URL', ['remote.origin.url', 'file:///tmp/other/acme/widgets'], '--add'],
		['a pushInsteadOf rule', ['url.ext::sh -c evil.pushInsteadOf', 'file:///'], ''],
		['extensions.partialClone naming another remote', ['extensions.partialClone', 'evil'], ''],
		['an empty partialCloneFilter on another remote', ['remote.evil.partialCloneFilter', ''], ''],
	])('refuses a clone with %s', async (_name, [key, value], flag) => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			...(flag ? [flag] : []),
			key as string,
			value as string,
		]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
	});

	it('refreshes hundreds of PRs with zero compare calls', async () => {
		const [, c2] = world.c;
		const stale = openPull(1, c2 as string, { 'x.txt': 'x' });
		const numbers = Array.from({ length: 249 }, (_, index) => index + 2);
		world.fixture.pulls(numbers, stale);
		for (const number of numbers) {
			world.github.pull({ number, headSha: stale });
		}
		const result = await client({ maxWritesPerRun: 10 }).refreshPrStatuses();
		expect(result.openPulls).toBe(250);
		expect(result.ancestry).toBe('git');
		// One head shared by every PR: written once, then skipped 249 times.
		expect(result).toMatchObject({ written: 1, skipped: 249, incomplete: false });
		expect(world.github.requests(/compare/)).toHaveLength(0);
		expect(world.logs.some((line) => line.includes('Fetched 250 PR heads'))).toBe(true);
	});
});

describe('git ancestry review round 12', () => {
	it('refuses transport settings hidden in an included file or the worktree scope', async () => {
		const include = `${world.fixture.root}/sneaky.inc`;
		writeFileSync(include, '[http]\n\tsslVerify = false\n');
		world.fixture.git(world.fixture.cloneDir, ['config', 'include.path', include]);
		expect((await client().report()).ancestry).toBe('api');
		world.fixture.git(world.fixture.cloneDir, ['config', '--unset', 'include.path']);
		world.fixture.git(world.fixture.cloneDir, ['config', 'extensions.worktreeConfig', 'true']);
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'--worktree',
			'remote.origin.proxy',
			'http://evil.example:8080',
		]);
		expect((await client().report()).ancestry).toBe('api');
	});

	it('refuses an empty second remote URL', async () => {
		world.fixture.git(world.fixture.cloneDir, ['config', '--add', 'remote.origin.url', '']);
		expect((await client().report()).ancestry).toBe('api');
	});

	it('counts an open PR whose pull ref is absent as bound by every baseline', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'packages/a/x.ts': 'x' });
		world.fixture.deletePull(1);
		const result = await client({
			baselines: [{ name: 'pr-baseline' }, { name: 'pkg-a', scope: ['packages/a/'] }],
		}).report();
		expect(result.baselines.map((baseline) => baseline.bound)).toEqual([1, 1]);
		expect(result.stale).toBe(1);
	});
});

describe('git ancestry review round 13', () => {
	it('refuses a clone with an alternate refs command', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'core.alternateRefsCommand',
			'env > /tmp/x',
		]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/does not have/);
	});

	it('reports the known open PR count when the second listing is rate limited', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		let listings = 0;
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/graphql') && ++listings === 2) {
				return new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return original(input, init);
		};
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ openPulls: 1, incomplete: true, reason: 'rate-limit' });
	});
});

describe('git ancestry review round 14', () => {
	it('refuses a remote named after the saved URL that redirects the fetch', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			`remote.${world.fixture.remoteUrl}.url`,
			'/definitely/not/the/repository',
		]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/does not have/);
	});

	it('refuses an origin that carries the token as a URL credential and never prints it', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'https://x-access-token:test-token@github.com/acme/widgets.git',
		]);
		const result = await client().report();
		expect(result.ancestry).toBe('api');
		const error = await client({ ancestry: 'git' })
			.report()
			.catch((e: unknown) => e as Error);
		expect(String(error)).not.toContain('test-token');
		expect(world.warnings.join('\n')).not.toContain('test-token');
	});
});

describe('git ancestry review round 15', () => {
	it('refuses a clone with a path-scoped persisted header', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'http.https://github.com/acme/widgets.git.extraheader',
			'AUTHORIZATION: basic stale',
		]);
		expect((await client().report()).ancestry).toBe('api');
	});
});

describe('git ancestry review round 16', () => {
	it.each([
		['core.sshCommand', 'env > /tmp/x'],
		['remote.origin.uploadPack', '/tmp/evil-upload-pack'],
	])('refuses a clone with a local %s setting', async (key, value) => {
		world.fixture.git(world.fixture.cloneDir, ['config', key, value]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/does not have/);
	});

	it('uses an ssh clone offline only', async () => {
		const [, , , c4] = world.c;
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'git@github.com:acme/widgets.git',
		]);
		expect((await client().report()).ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('fetches over ssh');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/over ssh/);
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		expect((await offline.refreshPrStatus({ sha: c4 as string })).ancestry).toBe('git');
	});

	it('scrubs the token and its encoded form from git errors', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		rmSync(world.fixture.remoteDir, { recursive: true, force: true });
		const error = await client({ ancestry: 'git' })
			.refreshPrStatuses()
			.catch((e: unknown) => e as Error);
		expect(String(error)).not.toContain('test-token');
		expect(String(error)).not.toContain(
			Buffer.from('x-access-token:test-token').toString('base64'),
		);
	});
});

describe('git ancestry review round 17', () => {
	it('uses a plaintext http clone offline only', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'http://github.com/acme/widgets.git',
		]);
		expect((await client().report()).ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('fetches over http;');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/over http;/);
	});

	it('adopts a relative local-path remote', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'../remote/acme/widgets',
		]);
		expect((await client().report()).ancestry).toBe('git');
	});
});

describe('git ancestry review round 18', () => {
	it('serves an offline evaluation from a plaintext http clone', async () => {
		const [, , , c4] = world.c;
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'http://github.com/acme/widgets.git',
		]);
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		expect((await offline.refreshPrStatus({ sha: c4 as string })).ancestry).toBe('git');
	});

	it('refuses a clone with a bundle URI', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'fetch.bundleURI',
			'https://evil.example/bundle',
		]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/does not have/);
	});
});

describe('git ancestry review round 19', () => {
	it('never lets a local remote value become a git option', async () => {
		const marker = `${world.fixture.root}/upload-pack-ran`;
		const script = `${world.fixture.root}/acme/widgets`;
		mkdirSync(`${world.fixture.root}/acme`, { recursive: true });
		writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexec git-upload-pack "$@"\n`, {
			mode: 0o755,
		});
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'--',
			'remote.origin.url',
			`--upload-pack=${script}`,
		]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/does not have/);
		expect(existsSync(marker)).toBe(false);
	});
});

describe('git ancestry review round 20', () => {
	it('never fetches from a UNC remote online', async () => {
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'file://server/share/acme/widgets',
		]);
		expect((await client().report()).ancestry).toBe('api');
		expect(world.warnings.join('\n')).toContain('fetches over unc');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/over unc/);
	});
});

describe('git ancestry review round 21', () => {
	it('never fetches from a four-slash file UNC remote online, but evaluates offline', async () => {
		const [, , , c4] = world.c;
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			'file:////server/share/acme/widgets',
		]);
		expect((await client().report()).ancestry).toBe('api');
		await expect(client({ ancestry: 'git' }).report()).rejects.toThrow(/over unc/);
		const offline = createClient({
			repo: 'acme/widgets',
			offline: true,
			base: 'main',
			gitDir: world.fixture.cloneDir,
			env: {},
			logger: { info() {}, warn() {} },
		});
		expect((await offline.refreshPrStatus({ sha: c4 as string })).ancestry).toBe('git');
	});
});

describe('git ancestry review round 22', () => {
	it('keeps the token out of git arguments in errors', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		// A remote path that happens to contain the token; the error must not echo it.
		mkdirSync(`${world.fixture.root}/test-token`, { recursive: true });
		world.fixture.git(world.fixture.cloneDir, [
			'remote',
			'set-url',
			'origin',
			`${world.fixture.root}/test-token/acme/widgets`,
		]);
		const error = await client({ ancestry: 'git' })
			.refreshPrStatuses()
			.catch((e: unknown) => e as Error);
		expect(String(error)).not.toContain('test-token');
		expect(world.warnings.join('\n')).not.toContain('test-token');
	});
});

describe('git ancestry review round 23', () => {
	it('refuses, without falling back, a remote baseline ref that no longer peels to a commit', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		// The API still reports the commit; on the remote the ref now points at a tree.
		const tree = world.fixture.git(world.fixture.workDir, ['rev-parse', `${c2}^{tree}`]).trim();
		world.github.refSource = undefined;
		world.fixture.baseline('pr-baseline', tree);
		await expect(client().refreshPrStatuses()).rejects.toThrow(
			/differs between the API and the remote/,
		);
		expect(world.warnings.join('\n')).not.toContain('falling back');
	});
});

describe('git ancestry review round 24', () => {
	it('writes no refs of its own and leaves foreign refs under the old namespace alone', async () => {
		const [, c2, c3] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const clone = world.fixture.cloneDir;
		world.fixture.git(clone, ['update-ref', 'refs/heads/sentinel', c3 as string]);
		world.fixture.git(clone, [
			'symbolic-ref',
			'refs/pr-baseline/old/pull/1',
			'refs/heads/sentinel',
		]);
		const before = world.fixture.git(clone, ['for-each-ref', '--format=%(refname)']).trim();
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, ancestry: 'git' });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
		expect(world.fixture.git(clone, ['rev-parse', 'refs/heads/sentinel']).trim()).toBe(c3);
		expect(world.fixture.git(clone, ['for-each-ref', '--format=%(refname)']).trim()).toBe(before);
	});

	it('keeps working when a baseline is renamed from foo to foo/bar between runs', async () => {
		const [, c2, c3] = world.c;
		world.fixture.baseline('foo', c3 as string);
		world.github.baseline('foo', c3 as string);
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		expect(
			(await client({ baselines: [{ name: 'foo' }] }).refreshPrStatus({ sha: head })).verdict
				.missing,
		).toEqual(['foo']);
		// Git itself cannot hold `foo` and `foo/bar` at once, so the rename deletes the old ref first.
		world.fixture.git(world.fixture.workDir, ['push', '--quiet', 'origin', ':refs/baselines/foo']);
		world.fixture.baseline('foo/bar', c3 as string);
		world.github.refs.delete('refs/baselines/foo');
		world.github.baseline('foo/bar', c3 as string);
		const result = await client({ baselines: [{ name: 'foo/bar' }] }).refreshPrStatus({
			sha: head,
		});
		expect(result.ancestry).toBe('git');
		expect(result.verdict.missing).toEqual(['foo/bar']);
	});
});

/** The command boundary's own wording, so the test fails if the writer swallows the removal error itself. */
const CLEANUP_DIAGNOSTIC = 'Could not remove the temporary repository (';

describe('move-baseline through a clone', () => {
	/** The lease writer over the treeless clone, talking to the fake API the way a run does. */
	async function writer(wrap: (repo: GitRepo) => GitRepo = (repo) => repo) {
		const repo = await openRepo(world.fixture.cloneDir, { token: 'test-token' });
		if (repo === null) {
			throw new Error('no clone');
		}
		const logger = {
			info: (message: string) => world.logs.push(message),
			warn: (message: string) => world.warnings.push(message),
		};
		const api = createApiClient({
			apiUrl: 'https://api.github.com',
			graphqlUrl: 'https://api.github.com/graphql',
			token: 'test-token',
			fetch: (input, init) => world.github.fetch(input, init),
			retryBaseMs: 0,
			logger,
		});
		return createLeaseRefWriter(wrap(repo), { api, repo: world.github.repo });
	}

	it('moves with a lease push and never touches the refs API', async () => {
		const [, c2, c3, c4] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		const result = await client().moveBaseline({ force: true, refreshPrStatuses: true });
		expect(result.moves[0]).toMatchObject({
			moved: true,
			from: c3,
			to: c4,
			reason: 'forced',
			via: 'git',
		});
		expect(world.warnings.join('\n')).not.toContain('temporary');
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c4);
		expect(world.github.requests(/\/git\/refs/, 'PATCH')).toHaveLength(0);
		expect(world.github.requests(/\/git\/refs$/, 'POST')).toHaveLength(0);
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('seeds an absent baseline with a lease on its absence', async () => {
		const [, , , c4] = world.c;
		world.fixture.git(world.fixture.workDir, [
			'push',
			'--quiet',
			'origin',
			':refs/baselines/pr-baseline',
		]);
		const result = await client().moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: null, to: c4 });
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c4);
		const again = await (await writer()).move('pr-baseline', null, c4 as string);
		expect(again).toEqual({ ok: false, actual: c4 });
	});

	it('reports the advertised commit instead of pushing when the lease is stale', async () => {
		const [, c2, c3, c4] = world.c;
		const lease = await writer();
		expect(await lease.move('pr-baseline', c2 as string, c4 as string)).toEqual({
			ok: false,
			actual: c3,
		});
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c3);
		expect(await lease.move('pr-baseline', c3 as string, c4 as string)).toEqual({
			ok: true,
			via: 'git',
		});
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c4);
	});

	it('leases on the tag object a baseline is parked on and replaces it with the commit', async () => {
		const [, , c3, c4] = world.c;
		world.fixture.baseline('pr-baseline', c3 as string, true);
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.type).toBe('tag');
		const result = await client().moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4 });
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')).toMatchObject({
			type: 'commit',
			sha: c4,
		});
	});

	it.skipIf(process.platform === 'win32')(
		'falls back to the refs API when every lease push fails with the ref unmoved',
		async () => {
			const [, , c3, c4] = world.c;
			const { chmodSync } = await import('node:fs');
			const refsDir = `${world.fixture.remoteDir}/refs/baselines`;
			chmodSync(refsDir, 0o555);
			// The API stands alone here, as it does when only the git transport is broken.
			world.github.refSource = undefined;
			world.github.onRefWrite = undefined;
			world.github.baseline('pr-baseline', c3 as string);
			try {
				const result = await client({ serverUrl: world.fixture.serverUrl }).moveBaseline({
					force: true,
				});
				expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'api' });
				expect(world.warnings.filter((line) => line.includes('trying the next way'))).toHaveLength(
					2,
				);
				expect(world.github.requests(/\/git\/refs\/baselines\/pr-baseline/, 'PATCH')).toHaveLength(
					1,
				);
			} finally {
				chmodSync(refsDir, 0o755);
			}
		},
	);

	it('loses the lease to a push that lands between ls-remote and its own push, and reports the winner', async () => {
		const [, c2, c3, c4] = world.c;
		let pushes = 0;
		const lease = await writer((repo) => ({
			...repo,
			async git(args, extraEnv) {
				// Another writer moves the ref right after this run confirmed the lease and before it pushes.
				if (args[0] === 'push' && pushes++ === 0) {
					world.fixture.baseline('pr-baseline', c2 as string);
				}
				return repo.git(args, extraEnv);
			},
		}));
		expect(await lease.move('pr-baseline', c3 as string, c4 as string)).toEqual({
			ok: false,
			actual: c2,
		});
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c2);
		expect(pushes).toBe(1);
	});

	it('pushes the leased ref and nothing else, whatever the clone asks for', async () => {
		const [, , c3, c4] = world.c;
		const clone = world.fixture.cloneDir;
		world.fixture.git(clone, ['config', 'push.followTags', 'true']);
		world.fixture.git(clone, ['config', 'push.recurseSubmodules', 'on-demand']);
		world.fixture.git(clone, ['config', 'push.pushOption', 'lab=1']);
		world.fixture.git(clone, ['tag', '-a', '-m', 'stray', 'stray', c4 as string]);
		const refs = (): Map<string, string> =>
			new Map(
				world.fixture
					.git(world.fixture.remoteDir, ['for-each-ref', '--format=%(refname) %(objectname)'])
					.trim()
					.split('\n')
					.map((line) => line.split(' ') as [string, string]),
			);
		const before = refs();
		const result = await client().moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'git' });
		// The clone's own push must have done it: a fallback would hide a leaked setting.
		expect(world.warnings.join('\n')).not.toContain('trying the next way');
		before.set('refs/baselines/pr-baseline', c4 as string);
		expect(refs()).toEqual(before);
		expect(world.fixture.remoteRef('refs/tags/stray')).toBeNull();
	});

	it('passes every hardening flag on the push itself', async () => {
		const [, , c3, c4] = world.c;
		const pushes: string[][] = [];
		const lease = await writer((repo) => ({
			...repo,
			async git(args, extraEnv) {
				if (args[0] === 'push') {
					pushes.push(args);
				}
				return repo.git(args, extraEnv);
			},
		}));
		expect(await lease.move('pr-baseline', c3 as string, c4 as string)).toEqual({
			ok: true,
			via: 'git',
		});
		expect(pushes).toHaveLength(1);
		expect(pushes[0]).toEqual(
			expect.arrayContaining([
				'--no-verify',
				'--no-signed',
				'--no-follow-tags',
				'--recurse-submodules=no',
				`--force-with-lease=refs/baselines/pr-baseline:${c3}`,
			]),
		);
	});

	it('never signs a push, whatever the clone asks for', async () => {
		const [, , c3, c4] = world.c;
		world.fixture.git(world.fixture.cloneDir, ['config', 'push.gpgSign', 'true']);
		world.fixture.git(world.fixture.cloneDir, [
			'config',
			'gpg.program',
			`${world.fixture.root}/no-such-gpg`,
		]);
		const result = await client().moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'git' });
		expect(world.warnings.join('\n')).not.toContain('trying the next way');
	});

	it('lease-pushes from a temporary repository when the run has no usable clone', async () => {
		const [, c2, c3, c4] = world.c;
		const head = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.shallowClone();
		const result = await client({ serverUrl: world.fixture.serverUrl }).moveBaseline({
			force: true,
			refreshPrStatuses: true,
		});
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'git' });
		expect(result.refresh).toMatchObject({ ancestry: 'api', written: 1 });
		expect(world.fixture.remoteRef('refs/baselines/pr-baseline')?.sha).toBe(c4);
		expect(world.github.requests(/\/git\/refs/, 'PATCH')).toHaveLength(0);
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('bootstraps the temporary repository under the hardened environment', async () => {
		const [, , c3, c4] = world.c;
		world.fixture.shallowClone();
		const hijack = `${world.fixture.root}/hijack`;
		const previous = process.env['GIT_DIR'];
		process.env['GIT_DIR'] = hijack;
		try {
			const result = await client({ serverUrl: world.fixture.serverUrl }).moveBaseline({
				force: true,
			});
			expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'git' });
		} finally {
			if (previous === undefined) {
				delete process.env['GIT_DIR'];
			} else {
				process.env['GIT_DIR'] = previous;
			}
		}
		expect(existsSync(hijack)).toBe(false);
	});

	it('falls back to the refs API when no temporary repository can be created', async () => {
		const [, , c3, c4] = world.c;
		world.fixture.shallowClone();
		world.github.refSource = undefined;
		world.github.baseline('pr-baseline', c3 as string);
		const previous = process.env['TMPDIR'];
		process.env['TMPDIR'] = `${world.fixture.root}/missing`;
		try {
			const result = await client({ serverUrl: world.fixture.serverUrl }).moveBaseline({
				force: true,
			});
			expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'api' });
		} finally {
			if (previous === undefined) {
				delete process.env['TMPDIR'];
			} else {
				process.env['TMPDIR'] = previous;
			}
		}
		expect(world.warnings.join('\n')).toContain('No temporary directory');
		expect(world.warnings.join('\n')).toContain('cannot refuse a concurrent move');
	});

	it.skipIf(process.platform === 'win32').each([
		['a plain logger', (message: string) => world.warnings.push(message)],
		[
			'a logger that throws on the diagnostic',
			(message: string) => {
				world.warnings.push(message);
				if (message.startsWith(CLEANUP_DIAGNOSTIC)) {
					throw new Error(`logger refused: ${message}`);
				}
			},
		],
	])(
		'warns and still succeeds when the temporary repository cannot be removed, with %s',
		async (_name, warn) => {
			const [, , c3, c4] = world.c;
			const { chmodSync, mkdirSync: mkdir } = await import('node:fs');
			world.fixture.shallowClone();
			world.github.refSource = undefined;
			world.github.onRefWrite = undefined;
			world.github.baseline('pr-baseline', c3 as string);
			const tmp = `${world.fixture.root}/tmp`;
			mkdir(tmp);
			const previous = process.env['TMPDIR'];
			process.env['TMPDIR'] = tmp;
			// The remote refuses the lease push, so the run reaches the API writer with the temporary repository alive.
			const refsDir = `${world.fixture.remoteDir}/refs/baselines`;
			chmodSync(refsDir, 0o555);
			const original = world.github.fetch;
			world.github.fetch = async (input, init) => {
				// Once the API write is under way, the temporary directory's parent stops allowing removals.
				if ((init?.method ?? '').toUpperCase() === 'PATCH') {
					chmodSync(tmp, 0o555);
				}
				return original(input, init);
			};
			try {
				const result = await client({
					serverUrl: world.fixture.serverUrl,
					logger: { info() {}, warn },
				}).moveBaseline({ force: true });
				expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'api' });
				expect(world.warnings.filter((line) => line.startsWith(CLEANUP_DIAGNOSTIC))).toHaveLength(
					1,
				);
			} finally {
				chmodSync(tmp, 0o755);
				chmodSync(refsDir, 0o755);
				if (previous === undefined) {
					delete process.env['TMPDIR'];
				} else {
					process.env['TMPDIR'] = previous;
				}
			}
		},
	);

	it('keeps the writes on the refs API with --ancestry api', async () => {
		const [, , c3, c4] = world.c;
		world.github.refSource = undefined;
		world.github.baseline('pr-baseline', c3 as string);
		const result = await client({ ancestry: 'api' }).moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: c3, to: c4, via: 'api' });
		expect(world.github.requests(/\/git\/refs\/baselines\/pr-baseline/, 'PATCH')).toHaveLength(1);
	});
});

describe('lagging pull refs', () => {
	it('evaluates the API head when the pull ref is stuck on its parent', async () => {
		const [, c2] = world.c;
		const stuck = openPull(1, c2 as string, { 'x.txt': 'x' });
		const head = laggingHead(1, stuck, { 'x.txt': 'xx' });
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, deferred: 0, incomplete: false });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
		expect(world.github.latestStatus(stuck, 'PR baseline')).toBeNull();
		expect(world.logs.join('\n')).toContain('refs/pull/1/head lags the API head');
	});

	it('evaluates the new head of a PR pushed between the head fetch and the second listing', async () => {
		const [, c2] = world.c;
		const old = openPull(1, c2 as string, { 'x.txt': 'x' });
		let head = '';
		let listings = 0;
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const response = await original(input, init);
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/graphql') && ++listings === 1) {
				head = laggingHead(1, old, { 'x.txt': 'xx' });
			}
			return response;
		};
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, deferred: 0, incomplete: false });
		expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
	});

	it('evaluates a force-pushed head the pull ref has not caught up with', async () => {
		const [, c2, , c4] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		const replacement = laggingHead(1, c4 as string, { 'x.txt': 'rebased' });
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, deferred: 0, incomplete: false });
		expect(world.github.latestStatus(replacement, 'PR baseline')?.state).toBe('success');
	});

	it('defers a PR whose pull ref is ahead of both API reads', async () => {
		const [, c2] = world.c;
		const listed = openPull(1, c2 as string, { 'x.txt': 'x' });
		world.fixture.checkout('pr-1');
		const newer = world.fixture.commit('newer', { 'x.txt': 'xx' });
		world.fixture.checkout('main');
		world.fixture.pull(1, newer);
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, deferred: 1, incomplete: true, reason: 'deferred' });
		expect(world.github.latestStatus(listed, 'PR baseline')).toBeNull();
		expect(world.warnings.join('\n')).toContain('PR #1 is still moving');
	});

	it.each(['auto', 'git'] as const)(
		'defers a head the remote does not serve without leaving git ancestry (%s)',
		async (ancestry) => {
			const [, c2] = world.c;
			openPull(1, c2 as string, { 'x.txt': 'x' });
			unservedHead(1);
			const result = await client({ ancestry }).refreshPrStatuses();
			expect(result).toMatchObject({ ancestry: 'git', deferred: 1, incomplete: true });
			expect(world.warnings.join('\n')).toContain('a head the remote does not serve');
		},
	);

	it('defers a PR missing from the second listing that REST still reports open', async () => {
		const [, c2] = world.c;
		openPull(1, c2 as string, { 'x.txt': 'x' });
		openPull(2, c2 as string, { 'y.txt': 'y' });
		let listings = 0;
		const original = world.github.fetch;
		world.github.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			const second = url.endsWith('/graphql') && ++listings === 2;
			const pull = world.github.pulls.get(2);
			if (second && pull) {
				pull.state = 'closed';
			}
			const response = await original(input, init);
			if (second && pull) {
				pull.state = 'open';
			}
			return response;
		};
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, deferred: 1, closed: 0, incomplete: true });
	});

	it('writes a head two lagging PRs share once', async () => {
		const [, c2] = world.c;
		const stuck = openPull(1, c2 as string, { 'x.txt': 'x' });
		openPull(2, c2 as string, { 'y.txt': 'y' });
		const head = laggingHead(1, stuck, { 'x.txt': 'xx' });
		const pull = world.github.pulls.get(2);
		if (pull) {
			pull.headSha = head;
		}
		const result = await client().refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, skipped: 1, deferred: 0, incomplete: false });
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	describe('when fetching the lagging head fails', () => {
		/** Breaks the remote once the second listing is in, so only the per-PR prefetch can fail. */
		const breakRemoteAfterListings = (): void => {
			let listings = 0;
			const original = world.github.fetch;
			world.github.fetch = async (input, init) => {
				const response = await original(input, init);
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith('/graphql') && ++listings === 2) {
					renameSync(world.fixture.remoteDir, `${world.fixture.remoteDir}-gone`);
				}
				return response;
			};
		};

		afterEach(() => {
			if (existsSync(`${world.fixture.remoteDir}-gone`)) {
				renameSync(`${world.fixture.remoteDir}-gone`, world.fixture.remoteDir);
			}
		});

		it('falls back to API ancestry under auto and still evaluates the head', async () => {
			const [, c2] = world.c;
			const stuck = openPull(1, c2 as string, { 'x.txt': 'x' });
			const head = laggingHead(1, stuck, { 'x.txt': 'xx' });
			breakRemoteAfterListings();
			const result = await client().refreshPrStatuses();
			expect(result).toMatchObject({ ancestry: 'api', written: 1, deferred: 0, incomplete: false });
			expect(world.github.latestStatus(head, 'PR baseline')?.state).toBe('failure');
			expect(world.github.requests(/compare/).length).toBeGreaterThan(0);
		});

		it('fails the run under forced git ancestry', async () => {
			const [, c2] = world.c;
			const stuck = openPull(1, c2 as string, { 'x.txt': 'x' });
			laggingHead(1, stuck, { 'x.txt': 'xx' });
			breakRemoteAfterListings();
			await expect(client({ ancestry: 'git' }).refreshPrStatuses()).rejects.toThrow();
		});

		it('stops on a rate limit from the descendant check after the fallback', async () => {
			const [, c2] = world.c;
			const stuck = openPull(1, c2 as string, { 'x.txt': 'x' });
			const head = laggingHead(1, stuck, { 'x.txt': 'xx' });
			breakRemoteAfterListings();
			world.github.overrides.push({
				path: /\/compare\//,
				status: 403,
				headers: { 'x-ratelimit-remaining': '0' },
			});
			const result = await client().refreshPrStatuses();
			expect(result).toMatchObject({ written: 0, incomplete: true, reason: 'rate-limit' });
			expect(world.github.latestStatus(head, 'PR baseline')).toBeNull();
		});
	});
});
