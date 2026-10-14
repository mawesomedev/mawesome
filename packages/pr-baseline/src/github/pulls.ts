import type { StatusRecord, StatusState } from '../types.ts';
import { repoParts, type ApiClient } from './api.ts';
import { isGitHubError } from './errors.ts';

export interface OpenPull {
	number: number;
	headSha: string;
	isDraft: boolean;
	baseRef: string;
	/** The branch the PR's stack lands on; null outside a stack. */
	stackBaseRef: string | null;
	/** The head repository's `owner/name`; null when it was deleted. */
	headRepo: string | null;
	status: StatusRecord | null;
}

export interface PullInfo {
	number: number;
	state: 'open' | 'closed';
	merged: boolean;
	draft: boolean;
	headSha: string;
	baseRef: string;
	/** The branch the PR's stack lands on; null outside a stack. */
	stackBaseRef: string | null;
}

/** The branch a PR lands on: its stack's base, which GitHub enforces the base's rules for, or its own base. */
export function targetBase(pull: { baseRef: string; stackBaseRef: string | null }): string {
	return pull.stackBaseRef ?? pull.baseRef;
}

interface StatusContextNode {
	state: string;
	description: string | null;
	targetUrl: string | null;
	creator: { login: string; __typename?: string } | null;
}

interface PullNode {
	number: number;
	isDraft: boolean;
	headRefOid: string;
	baseRefName: string;
	headRepository: { nameWithOwner: string } | null;
	commits: {
		nodes: Array<{ commit: { status: { context: StatusContextNode | null } | null } }>;
	};
	/** Absent when the query does not select it, as on a server without stacks. */
	stack?: {
		baseRefName: string;
		entries: { nodes: Array<{ pullRequest: { id: string; number: number; state: string } }> };
	} | null;
}

interface OpenPullsData {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: PullNode[];
		};
	};
}

interface PullNodesData {
	nodes: Array<PullNode | null>;
}

interface LabeledMergesData {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: Array<{ number: number; mergeCommit: { oid: string } | null }>;
		};
	};
}

interface CommitStatusData {
	repository: {
		object: { status: { context: StatusContextNode | null } | null } | null;
	};
}

const PULL_FIELDS = `
	number
	isDraft
	headRefOid
	baseRefName
	headRepository { nameWithOwner }
	commits(last: 1) {
		nodes { commit { status { context(name: $context) { state description targetUrl creator { login __typename } } } } }
	}
`;

/** A stack holds a handful of PRs; 100 entries is the most one page of a connection returns. */
const STACK_FIELDS = `
	stack { baseRefName entries(first: 100) { nodes { pullRequest { id number state } } } }
`;

const openPullsQuery = (stacks: boolean) => `
	query ($owner: String!, $name: String!, $base: String!, $context: String!, $cursor: String) {
		repository(owner: $owner, name: $name) {
			pullRequests(states: OPEN, baseRefName: $base, first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
				pageInfo { hasNextPage endCursor }
				nodes { ${PULL_FIELDS} ${stacks ? STACK_FIELDS : ''} }
			}
		}
	}
`;

const PULL_NODES_QUERY = `
	query ($ids: [ID!]!, $context: String!) {
		nodes(ids: $ids) { ... on PullRequest { ${PULL_FIELDS} ${STACK_FIELDS} } }
	}
`;

const LABELED_MERGES_QUERY = `
	query ($owner: String!, $name: String!, $base: String!, $label: String!, $cursor: String) {
		repository(owner: $owner, name: $name) {
			pullRequests(states: MERGED, baseRefName: $base, labels: [$label], first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
				pageInfo { hasNextPage endCursor }
				nodes { number mergeCommit { oid } }
			}
		}
	}
`;

const COMMIT_STATUS_QUERY = `
	query ($owner: String!, $name: String!, $oid: GitObjectID!, $context: String!) {
		repository(owner: $owner, name: $name) {
			object(oid: $oid) {
				... on Commit { status { context(name: $context) { state description targetUrl creator { login __typename } } } }
			}
		}
	}
`;

/**
 * Lists open PRs that land on `base` with each head's latest status for `context`, one page per 100 PRs.
 * A stack's upper PRs target other branches, so they are reached through the stack of the PR at its bottom.
 */
export async function listOpenPulls(
	api: ApiClient,
	repo: string,
	input: { base: string; context: string },
): Promise<OpenPull[]> {
	const [owner, name] = repo.split('/');
	const pulls = new Map<number, OpenPull>();
	const stacked = new Map<number, string>();
	let stacks = true;
	let cursor: string | null = null;
	for (;;) {
		const variables = { owner, name, base: input.base, context: input.context, cursor };
		let data: OpenPullsData;
		try {
			data = await api.graphql<OpenPullsData>(openPullsQuery(stacks), variables);
		} catch (error) {
			if (!stacks || !lacksStacks(error)) {
				throw error;
			}
			// A server that predates stacks rejects the field; its PRs all target their base directly.
			stacks = false;
			continue;
		}
		const page = data.repository.pullRequests;
		for (const node of page.nodes) {
			pulls.set(node.number, toOpenPull(node));
			for (const entry of node.stack?.entries.nodes ?? []) {
				if (entry.pullRequest.state === 'OPEN' && node.stack?.baseRefName === input.base) {
					stacked.set(entry.pullRequest.number, entry.pullRequest.id);
				}
			}
		}
		if (!page.pageInfo.hasNextPage) {
			break;
		}
		cursor = page.pageInfo.endCursor;
	}
	const missing = [...stacked].filter(([number]) => !pulls.has(number)).map(([, id]) => id);
	for (let index = 0; index < missing.length; index += 100) {
		const data = await api.graphql<PullNodesData>(PULL_NODES_QUERY, {
			ids: missing.slice(index, index + 100),
			context: input.context,
		});
		for (const node of data.nodes) {
			if (node !== null) {
				pulls.set(node.number, toOpenPull(node));
			}
		}
	}
	return [...pulls.values()];
}

function toOpenPull(node: PullNode): OpenPull {
	return {
		number: node.number,
		headSha: node.headRefOid,
		isDraft: node.isDraft,
		baseRef: node.baseRefName,
		stackBaseRef: node.stack?.baseRefName ?? null,
		headRepo: node.headRepository?.nameWithOwner ?? null,
		status: toRecord(node.commits.nodes[0]?.commit.status?.context ?? null),
	};
}

/** GitHub names the unknown field in the error; GHES before stacks has no `stack` on a PR. */
function lacksStacks(error: unknown): boolean {
	return isGitHubError(error) && /Field 'stack' doesn't exist/.test(error.body);
}

/** Merge commits of every merged PR against `base` that carries `label`, newest first, exhaustively. */
export async function listLabeledMergeCommits(
	api: ApiClient,
	repo: string,
	input: { base: string; label: string },
): Promise<string[]> {
	const [owner, name] = repo.split('/');
	const oids: string[] = [];
	let cursor: string | null = null;
	for (;;) {
		const data: LabeledMergesData = await api.graphql<LabeledMergesData>(LABELED_MERGES_QUERY, {
			owner,
			name,
			base: input.base,
			label: input.label,
			cursor,
		});
		const page = data.repository.pullRequests;
		for (const node of page.nodes) {
			if (node.mergeCommit) {
				oids.push(node.mergeCommit.oid);
			}
		}
		if (!page.pageInfo.hasNextPage) {
			return oids;
		}
		cursor = page.pageInfo.endCursor;
	}
}

/** The latest status for `context` on one commit; null when there is none. */
export async function readCommitStatus(
	api: ApiClient,
	repo: string,
	input: { sha: string; context: string },
): Promise<StatusRecord | null> {
	const [owner, name] = repo.split('/');
	const data = await api.graphql<CommitStatusData>(COMMIT_STATUS_QUERY, {
		owner,
		name,
		oid: input.sha,
		context: input.context,
	});
	return toRecord(data.repository.object?.status?.context ?? null);
}

/** Reads one PR through REST; null when it does not exist. */
export async function getPull(
	api: ApiClient,
	repo: string,
	number: number,
): Promise<PullInfo | null> {
	try {
		const pull = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
			...repoParts(repo),
			pull_number: number,
		});
		// Newer than the generated types; absent on a server without stacks.
		const stack = (pull.data as { stack?: { base: { ref: string } } | null }).stack;
		return {
			number: pull.data.number,
			state: pull.data.state,
			merged: pull.data.merged,
			draft: pull.data.draft ?? false,
			headSha: pull.data.head.sha,
			baseRef: pull.data.base.ref,
			stackBaseRef: stack?.base.ref ?? null,
		};
	} catch (error) {
		if (isGitHubError(error, 'not-found')) {
			return null;
		}
		throw error;
	}
}

function toRecord(node: StatusContextNode | null): StatusRecord | null {
	if (node === null) {
		return null;
	}
	return {
		state: node.state.toLowerCase() as StatusState,
		description: node.description,
		targetUrl: node.targetUrl,
		creator: node.creator === null ? null : creatorLogin(node.creator),
	};
}

/** GraphQL names a bot by its bare login; REST and the resolved creator carry the `[bot]` suffix, so it is restored here. */
function creatorLogin(creator: { login: string; __typename?: string }): string {
	return creator.__typename === 'Bot' && !creator.login.endsWith('[bot]')
		? `${creator.login}[bot]`
		: creator.login;
}
