import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import type { Logger } from '../types.ts';
import { classifyFailure, GitHubError, retryAfterMs } from './errors.ts';

/** Two retries, so a request is attempted three times before its server error surfaces. */
const RETRIES = 2;
/*
 * No 4xx is ever retried: rate limits and ref races are decisions for the commands.
 * Octokit reports a failed fetch as a 500 without a response, so 5xx and network failures share the retry path.
 */
const DO_NOT_RETRY = Array.from({ length: 100 }, (_, index) => 400 + index);

const OctokitWithRetry = Octokit.plugin(retry);

export interface RateLimitSnapshot {
	remaining: number | null;
	/** Unix seconds when the window resets. */
	reset: number | null;
}

/** The official client plus the run-level state the commands need; every failure is a `GitHubError`. */
export interface ApiClient {
	readonly hasToken: boolean;
	/** Latest primary rate-limit headers seen on REST responses. */
	readonly rest: RateLimitSnapshot;
	/** Latest primary rate-limit headers seen on GraphQL responses. */
	readonly graphqlLimit: RateLimitSnapshot;
	/** Typed REST requests by route, as `octokit.request`. */
	readonly request: Octokit['request'];
	graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface ApiClientOptions {
	apiUrl: string;
	graphqlUrl: string;
	token: string | undefined;
	fetch: typeof fetch;
	/** Base delay for the retry backoff; tests shrink it. */
	retryBaseMs: number;
	logger: Logger;
}

type HeaderBag = Record<string, string | number | undefined> | undefined;

interface OctokitFailure {
	status?: number;
	message?: string;
	response?: { headers?: HeaderBag; data?: unknown };
	/** Present on a GraphQL response carrying errors. */
	errors?: Array<{ type?: string; message?: string }>;
	headers?: HeaderBag;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
	const { apiUrl, graphqlUrl, token, retryBaseMs } = options;
	const rest: RateLimitSnapshot = { remaining: null, reset: null };
	const graphqlLimit: RateLimitSnapshot = { remaining: null, reset: null };
	const snapshotFor = (url: unknown): RateLimitSnapshot =>
		String(url) === graphqlUrl ? graphqlLimit : rest;

	const octokit = new OctokitWithRetry({
		baseUrl: apiUrl,
		...(token === undefined ? {} : { auth: token }),
		userAgent: 'pr-baseline',
		request: { fetch: rejectEmptyGraphql(options.fetch, graphqlUrl) },
		retry: { doNotRetry: DO_NOT_RETRY, retries: RETRIES, retryAfterBaseValue: retryBaseMs },
	});
	octokit.hook.after('request', (response, requestOptions) => {
		track(snapshotFor(requestOptions.url), response.headers as HeaderBag);
	});
	// Registered after the retry plugin, so this wrapper sees the final outcome of every request.
	octokit.hook.wrap('request', async (request, requestOptions) => {
		try {
			return await request(requestOptions);
		} catch (error) {
			const failure = error as OctokitFailure;
			track(snapshotFor(requestOptions.url), failure.response?.headers);
			throw translate(error, `${requestOptions.method} ${requestOptions.url}`);
		}
	});

	return {
		hasToken: token !== undefined,
		rest,
		graphqlLimit,
		request: octokit.request,
		async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
			// Posted to the configured endpoint verbatim; Octokit's own helper only derives it from the REST root.
			const response = await octokit.request(`POST ${graphqlUrl}`, { query, variables });
			const envelope = response.data as {
				data?: T;
				errors?: Array<{ type?: string; message?: string }>;
			};
			if (envelope.errors && envelope.errors.length > 0) {
				throw translate(
					Object.assign(new Error('GraphQL errors'), { errors: envelope.errors }),
					'POST /graphql',
				);
			}
			return envelope.data as T;
		},
	};
}

/**
 * Turns a 200 GraphQL response without data or errors (an empty or truncated body) into a 502.
 * The retry plugin then retries it, and a final failure carries the body instead of a TypeError.
 */
function rejectEmptyGraphql(fetcher: typeof fetch, graphqlUrl: string): typeof fetch {
	return async (input, init) => {
		const response = await fetcher(input, init);
		const url = input instanceof Request ? input.url : String(input);
		if (url !== graphqlUrl || response.status !== 200) {
			return response;
		}
		const text = await response.clone().text();
		if (hasDataOrErrors(text)) {
			return response;
		}
		const message = `GraphQL returned 200 without data: ${JSON.stringify(text.slice(0, 200))}`;
		// Rate-limit headers stay for tracking; the body headers describe the replaced body.
		const headers = new Headers(response.headers);
		headers.delete('content-length');
		headers.delete('content-encoding');
		headers.set('content-type', 'application/json; charset=utf-8');
		return new Response(JSON.stringify({ message }), { status: 502, headers });
	};
}

function hasDataOrErrors(text: string): boolean {
	try {
		const envelope = JSON.parse(text) as { data?: unknown; errors?: unknown } | null;
		return (
			(typeof envelope?.data === 'object' && envelope.data !== null) ||
			(Array.isArray(envelope?.errors) && envelope.errors.length > 0)
		);
	} catch {
		return false;
	}
}

/** Maps an Octokit failure onto the tool's classification; other errors pass through unchanged. */
function translate(error: unknown, path: string): unknown {
	if (error instanceof GitHubError || !(error instanceof Error)) {
		return error;
	}
	const failure = error as OctokitFailure;
	// The retry plugin wraps a GraphQL "Something went wrong" envelope in a synthetic 500 that keeps the envelope.
	const wrapped = (failure.response?.data as { errors?: OctokitFailure['errors'] } | undefined)
		?.errors;
	const errors = failure.errors ?? (Array.isArray(wrapped) ? wrapped : undefined);
	if (Array.isArray(errors)) {
		// A GraphQL rate limit is a 200 carrying a RATE_LIMITED error.
		const body = JSON.stringify(errors);
		if (errors.some((entry) => entry.type === 'RATE_LIMITED')) {
			return new GitHubError('rate-limit', path, 'GitHub GraphQL rate limit reached.', {
				status: 200,
				body,
				cause: error,
			});
		}
		return new GitHubError(
			failure.status !== undefined && failure.status >= 500 ? 'server' : 'other',
			path,
			`GraphQL request failed: ${body}`,
			{ status: failure.status ?? 200, body, cause: error },
		);
	}
	if (typeof failure.status !== 'number') {
		return error;
	}
	if (failure.response === undefined) {
		// Octokit reports a failed fetch as a 500 without a response.
		return new GitHubError('network', path, `Network error on ${path}: ${error.message}`, {
			cause: error,
		});
	}
	const headers = toHeaders(failure.response.headers);
	const data = failure.response.data;
	const body = typeof data === 'string' ? data : JSON.stringify(data ?? '');
	const kind = classifyFailure(failure.status, headers, body);
	const retryAfter = retryAfterMs(headers);
	return new GitHubError(kind, path, describe(kind, path, failure.status, body), {
		status: failure.status,
		body,
		cause: error,
		...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
	});
}

function toHeaders(bag: HeaderBag): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(bag ?? {})) {
		if (value !== undefined) {
			headers.set(name, String(value));
		}
	}
	return headers;
}

function track(snapshot: RateLimitSnapshot, bag: HeaderBag): void {
	const remaining = bag?.['x-ratelimit-remaining'];
	const reset = bag?.['x-ratelimit-reset'];
	if (remaining !== undefined && /^\d+$/.test(String(remaining))) {
		snapshot.remaining = Number(remaining);
	}
	if (reset !== undefined && /^\d+$/.test(String(reset))) {
		snapshot.reset = Number(reset);
	}
}

function describe(kind: string, path: string, status: number, body: string): string {
	switch (kind) {
		case 'rate-limit':
			return `GitHub API rate limit reached on ${path}.`;
		case 'auth':
			return `GitHub rejected the token on ${path} (401).`;
		case 'permission':
			return `The token lacks permission for ${path} (403): ${summary(body)}`;
		case 'status-cap':
			return `This commit already carries the maximum number of statuses for the context (${path}).`;
		default:
			return `GitHub API ${path} failed with ${status}: ${summary(body)}`;
	}
}

function summary(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: string };
		if (typeof parsed.message === 'string') {
			return parsed.message;
		}
	} catch {
		// Not JSON; fall through to the raw body.
	}
	return body.slice(0, 200);
}

/** Splits `owner/name` for typed routes. */
export function repoParts(repo: string): { owner: string; repo: string } {
	const [owner = '', name = ''] = repo.split('/');
	return { owner, repo: name };
}
