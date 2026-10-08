import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/github/api.ts';
import { GitHubError, isGitHubError } from '../../src/github/errors.ts';
import { FakeGitHub } from '@mawesome/testing/github';

const REPO = { owner: 'acme', repo: 'widgets' };

function client(
	github: FakeGitHub,
	overrides: { apiUrl?: string; graphqlUrl?: string; fetch?: typeof fetch } = {},
) {
	return createApiClient({
		apiUrl: 'https://api.github.com',
		graphqlUrl: 'https://api.github.com/graphql',
		token: 'token',
		fetch: github.fetch,
		retryBaseMs: 0,
		logger: { info() {}, warn() {} },
		...overrides,
	});
}

describe('createApiClient', () => {
	it('sends auth headers and tracks rate-limit headers per endpoint', async () => {
		const github = new FakeGitHub({ rateLimitRemaining: 10 });
		const api = client(github);
		const repo = await api.request('GET /repos/{owner}/{repo}', REPO);
		expect(repo.data.default_branch).toBe('main');
		expect(api.rest.remaining).toBe(9);
		expect(api.rest.reset).toBe(1700000000);
		expect(api.graphqlLimit.remaining).toBeNull();
		await api.graphql('query { object(oid: 1) }', { oid: 'x', context: 'c' });
		expect(api.graphqlLimit.remaining).toBe(8);
	});

	it('retries server errors and network failures three times, then gives up', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({ path: /^\/repos\//, status: 503, times: 2 });
		const repo = await api.request('GET /repos/{owner}/{repo}', REPO);
		expect(repo.data.default_branch).toBe('main');
		expect(github.calls).toHaveLength(3);

		github.calls.length = 0;
		github.overrides.push({ path: /^\/repos\//, status: 502, times: 3 });
		await expect(api.request('GET /repos/{owner}/{repo}', REPO)).rejects.toMatchObject({
			kind: 'server',
			status: 502,
		});
		expect(github.calls).toHaveLength(3);

		github.calls.length = 0;
		github.overrides.push({ path: /^\/repos\//, network: true, status: 0, times: 3 });
		await expect(api.request('GET /repos/{owner}/{repo}', REPO)).rejects.toMatchObject({
			kind: 'network',
		});
		expect(github.calls).toHaveLength(3);
	});

	it('classifies every rate-limit shape without retrying', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({ path: /./, status: 403, headers: { 'x-ratelimit-remaining': '0' } });
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'rate-limit' });
		github.overrides.push({ path: /./, status: 429, headers: { 'retry-after': '7' } });
		await expect(api.request('GET /user')).rejects.toMatchObject({
			kind: 'rate-limit',
			retryAfterMs: 7000,
		});
		github.overrides.push({
			path: /./,
			status: 403,
			body: { message: 'You have exceeded a secondary rate limit.' },
		});
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'rate-limit' });
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
		});
		await expect(api.graphql('query {}', {})).rejects.toMatchObject({ kind: 'rate-limit' });
		expect(github.calls).toHaveLength(4);
	});

	it('does not retry permission, validation or conflict errors', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({
			path: /./,
			status: 403,
			body: { message: 'Resource not accessible by integration' },
		});
		const error = await api.request('GET /user').catch((e: unknown) => e);
		expect(isGitHubError(error, 'permission')).toBe(true);
		expect((error as GitHubError).message).toContain('Resource not accessible by integration');
		github.overrides.push({
			path: /./,
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'validation' });
		github.overrides.push({ path: /./, status: 409 });
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'conflict' });
		expect(github.calls).toHaveLength(3);
	});

	it('reports a missing resource as not-found', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		await expect(
			api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...REPO, ref: 'tags/none' }),
		).rejects.toMatchObject({ kind: 'not-found' });
	});

	it('surfaces other GraphQL errors as failures', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ message: 'Field x does not exist' }] },
		});
		await expect(api.graphql('query {}', {})).rejects.toMatchObject({ kind: 'other' });
	});
});

describe('GitHub Enterprise Server endpoints', () => {
	it('sends REST under /api/v3 and GraphQL to /api/graphql', async () => {
		const github = new FakeGitHub({ restPrefix: '/api/v3', graphqlPath: '/api/graphql' });
		const api = client(github, {
			apiUrl: 'https://ghe.test/api/v3',
			graphqlUrl: 'https://ghe.test/api/graphql',
		});
		const repo = await api.request('GET /repos/{owner}/{repo}', REPO);
		expect(repo.data.default_branch).toBe('main');
		await expect(
			api.graphql('query { object(oid: 1) }', { oid: 'x', context: 'c' }),
		).resolves.toBeDefined();
		expect(github.calls.map((call) => call.path)).toEqual([
			'/api/v3/repos/acme/widgets',
			'/api/graphql',
		]);
	});
});

describe('retry policy', () => {
	it('retries any 5xx but never a 4xx, and records headers of failed responses', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({ path: /./, status: 405, times: 3 });
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'other', status: 405 });
		expect(github.calls).toHaveLength(1);
		github.overrides.length = 0;
		github.calls.length = 0;
		github.overrides.push({
			path: /./,
			status: 500,
			times: 2,
			headers: { 'x-ratelimit-remaining': '7' },
		});
		await api.request('GET /user');
		expect(github.calls).toHaveLength(3);
		github.calls.length = 0;
		github.overrides.push({ path: /./, status: 403, headers: { 'x-ratelimit-remaining': '0' } });
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'rate-limit' });
		expect(api.rest.remaining).toBe(0);
	});

	it('posts GraphQL to a custom endpoint verbatim', async () => {
		const github = new FakeGitHub({ graphqlPath: '/custom-gql' });
		const api = client(github, { graphqlUrl: 'https://api.github.com/custom-gql' });
		await api.graphql('query { object(oid: 1) }', { oid: 'x', context: 'c' });
		expect(github.calls.map((call) => call.path)).toEqual(['/custom-gql']);
		expect(api.graphqlLimit.remaining).not.toBeNull();
	});
});

describe('classification after retries', () => {
	it('reports an exhausted 500 as a server failure and tracks GraphQL headers on failure', async () => {
		const github = new FakeGitHub({ rateLimitRemaining: 3 });
		const api = client(github);
		github.overrides.push({ path: /./, status: 500, times: 3 });
		await expect(api.request('GET /user')).rejects.toMatchObject({ kind: 'server', status: 500 });
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED' }] },
			headers: { 'x-ratelimit-remaining': '0' },
		});
		await expect(api.graphql('query {}', {})).rejects.toMatchObject({ kind: 'rate-limit' });
		expect(api.graphqlLimit.remaining).toBe(0);
	});

	it('classifies a retry-wrapped GraphQL envelope as a server failure', async () => {
		const github = new FakeGitHub();
		const api = client(github);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			times: 3,
			body: { errors: [{ message: 'Something went wrong while executing your query.' }] },
		});
		await expect(api.graphql('query {}', {})).rejects.toMatchObject({ kind: 'server' });
		expect(github.calls).toHaveLength(3);
	});

	it.each(['', '{"data":{"repository":{"pullRe', '<html>timeout</html>', '{"data":null}'])(
		'retries a 200 GraphQL body without data (%j), then reports it as a server failure',
		async (body) => {
			const github = new FakeGitHub();
			let calls = 0;
			const fetcher: typeof fetch = async (input, init) => {
				calls++;
				const url = input instanceof Request ? input.url : String(input);
				return url.endsWith('/graphql')
					? new Response(body, {
							status: 200,
							headers: { 'content-type': 'application/json; charset=utf-8' },
						})
					: github.fetch(input, init);
			};
			const api = client(github, { fetch: fetcher });
			const failure = api.graphql('query {}', {});
			await expect(failure).rejects.toMatchObject({ kind: 'server', status: 502 });
			await expect(failure).rejects.toThrow(
				`GraphQL returned 200 without data: ${JSON.stringify(body)}`,
			);
			expect(calls).toBe(3);
		},
	);

	it('passes a GraphQL body through once a retry returns data', async () => {
		const github = new FakeGitHub();
		let calls = 0;
		const fetcher: typeof fetch = async (input, init) =>
			++calls === 1
				? new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
				: github.fetch(input, init);
		const api = client(github, { fetch: fetcher });
		await expect(
			api.graphql('query { object(oid: 1) }', { oid: 'x', context: 'c' }),
		).resolves.toBeDefined();
		expect(calls).toBe(2);
	});
});
