/**
 * An in-memory GitHub serving the REST and GraphQL routes the tool uses through a `fetch` double.
 * Ancestry comes from a commit graph, so tests describe repositories, not HTTP payloads.
 */

export interface FakePull {
	number: number;
	state: 'open' | 'closed';
	merged: boolean;
	headSha: string;
	baseRef: string;
	isDraft: boolean;
	labels: string[];
	mergeCommit: string | null;
	headRepo: string | null;
	/** The stack the PR sits in; its PRs share `id`, ordered by `position` from the one on `base`. */
	stack: { id: number; base: string; position: number } | null;
}

export interface FakeStatus {
	context: string;
	state: string;
	description: string | null;
	targetUrl: string | null;
	creator: string;
}

export interface Call {
	method: string;
	/** Decoded path with query. */
	path: string;
	/** The path exactly as requested, before percent-decoding. */
	rawPath: string;
	body: unknown;
}

export interface Override {
	/** Matches the request; every field is optional. */
	method?: string;
	path: RegExp;
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
	/** How many matching requests it intercepts; default 1. */
	times?: number;
	/** Throw a network error instead of responding. */
	network?: boolean;
}

export interface FakeGitHubOptions {
	repo?: string;
	defaultBranch?: string;
	/** Login `GET /user` returns; null makes it 403 like an installation token. */
	user?: string | null;
	/** Login statuses are created as. */
	creator?: string;
	rateLimitRemaining?: number;
	/** Path prefix REST routes live under, as `/api/v3` on GHES. */
	restPrefix?: string;
	/** Absolute path of the GraphQL endpoint; default `/graphql`. */
	graphqlPath?: string;
}

export function sha(n: number): string {
	return n.toString(16).padStart(40, '0');
}

export class FakeGitHub {
	readonly repo: string;
	readonly defaultBranch: string;
	readonly commits: Map<string, string[]> = new Map();
	readonly branches: Map<string, string> = new Map();
	/** Every ref outside `refs/heads/`, by full name, as GitHub's refs API serves it. */
	readonly refs: Map<string, { type: 'commit' | 'tag'; sha: string; peeled: string }> = new Map();
	readonly pulls: Map<number, FakePull> = new Map();
	readonly statuses: Map<string, FakeStatus[]> = new Map();
	/** Changed files for `from...to`; unknown pairs yield an empty list. */
	readonly files: Map<string, string[]> = new Map();
	readonly calls: Call[] = [];
	readonly overrides: Override[] = [];
	user: string | null;
	creator: string;
	/** Mirrors ref writes made through the API into a real remote, when a test pairs the fake with one. */
	onRefWrite: ((ref: string, sha: string) => void) | undefined;
	/** Answers ref reads from a real remote instead of `refs`, so a ref pushed there directly is what the API reports. */
	refSource: ((ref: string) => { type: string; sha: string; peeled: string } | null) | undefined;
	/** Answers tag-object reads from the same remote. */
	tagSource: ((sha: string) => { type: string; sha: string } | null) | undefined;
	rateLimitRemaining: number;
	readonly restPrefix: string;
	readonly graphqlPath: string;
	pageSize = 100;
	/** False serves a server that predates stacks: GraphQL rejects the field and REST omits it. */
	stacks = true;
	/** Renamed files for `from...to`, as `[previous, current]` pairs. */
	readonly renames: Map<string, Array<[string, string]>> = new Map();
	/** Tag objects pointing at other tag objects, by object SHA. */
	readonly nestedTags: Map<string, { type: 'commit' | 'tag'; sha: string }> = new Map();

	constructor(options: FakeGitHubOptions = {}) {
		this.repo = options.repo ?? 'acme/widgets';
		this.defaultBranch = options.defaultBranch ?? 'main';
		this.user = options.user === undefined ? 'octocat' : options.user;
		this.creator = options.creator ?? 'github-actions[bot]';
		this.rateLimitRemaining = options.rateLimitRemaining ?? 4000;
		this.restPrefix = options.restPrefix ?? '';
		this.graphqlPath = options.graphqlPath ?? '/graphql';
		this.fetch = this.fetch.bind(this);
	}

	commit(id: string, parents: string[] = []): string {
		this.commits.set(id, parents);
		return id;
	}

	/** Adds a linear chain of commits on top of `parent` and returns the tip. */
	chain(from: number, to: number, parent?: string): string {
		let tip = parent;
		for (let n = from; n <= to; n++) {
			const id = sha(n);
			this.commit(id, tip === undefined ? [] : [tip]);
			tip = id;
		}
		return tip as string;
	}

	branch(name: string, head: string): void {
		this.branches.set(name, head);
	}

	tag(name: string, target: string, annotated = false): void {
		this.setRef(`refs/tags/${name}`, target, annotated);
	}

	/** Points the baseline ref at a commit, or at a tag object peeling to it. */
	baseline(name: string, target: string, annotated = false): void {
		this.setRef(`refs/baselines/${name}`, target, annotated);
	}

	baselineAt(name: string): string | undefined {
		return this.lookupRef(`refs/baselines/${name}`)?.peeled;
	}

	hasBaseline(name: string): boolean {
		return this.lookupRef(`refs/baselines/${name}`) !== undefined;
	}

	private lookupRef(ref: string): { type: string; sha: string; peeled: string } | undefined {
		if (this.refSource !== undefined && !ref.startsWith('refs/heads/')) {
			return this.refSource(ref) ?? undefined;
		}
		return this.refs.get(ref);
	}

	private setRef(ref: string, target: string, annotated: boolean): void {
		if (annotated) {
			const objectSha = `t${target.slice(1)}`;
			this.refs.set(ref, { type: 'tag', sha: objectSha, peeled: target });
			return;
		}
		this.refs.set(ref, { type: 'commit', sha: target, peeled: target });
	}

	pull(input: Partial<FakePull> & { number: number; headSha: string }): FakePull {
		const pull: FakePull = {
			state: 'open',
			merged: false,
			baseRef: this.defaultBranch,
			isDraft: false,
			labels: [],
			mergeCommit: null,
			headRepo: this.repo,
			stack: null,
			...input,
		};
		this.pulls.set(pull.number, pull);
		return pull;
	}

	status(target: string, status: Partial<FakeStatus> & { state: string }): void {
		const list = this.statuses.get(target) ?? [];
		list.push({
			context: 'PR baseline',
			description: null,
			targetUrl: null,
			creator: this.creator,
			...status,
		});
		this.statuses.set(target, list);
	}

	latestStatus(target: string, context: string): FakeStatus | null {
		const list = this.statuses.get(target) ?? [];
		for (let index = list.length - 1; index >= 0; index--) {
			if (list[index]?.context === context) {
				return list[index] as FakeStatus;
			}
		}
		return null;
	}

	/** The commit a full ref points at, branches included; undefined when absent. */
	private refAt(ref: string): string | undefined {
		return ref.startsWith('refs/heads/')
			? this.branches.get(ref.slice('refs/heads/'.length))
			: this.lookupRef(ref)?.peeled;
	}

	private writeRef(ref: string, target: string): void {
		if (ref.startsWith('refs/heads/')) {
			this.branches.set(ref.slice('refs/heads/'.length), target);
		} else {
			this.setRef(ref, target, false);
		}
		this.onRefWrite?.(ref, target);
	}

	isAncestor(ancestor: string, descendant: string): boolean {
		const seen = new Set<string>();
		const queue = [descendant];
		while (queue.length > 0) {
			const current = queue.pop() as string;
			if (current === ancestor) {
				return true;
			}
			if (seen.has(current)) {
				continue;
			}
			seen.add(current);
			queue.push(...(this.commits.get(current) ?? []));
		}
		return false;
	}

	/** Requests whose path matches, in order. */
	requests(pattern: RegExp, method?: string): Call[] {
		return this.calls.filter(
			(call) => pattern.test(call.path) && (method === undefined || call.method === method),
		);
	}

	async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const url = new URL(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
		);
		const request = input instanceof Request ? input : undefined;
		const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
		const rawPath = url.pathname;
		url.pathname = decodeURIComponent(url.pathname);
		const path = `${url.pathname}${url.search}`;
		const rawBody = typeof init?.body === 'string' ? init.body : await request?.text();
		const body = rawBody !== undefined && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
		this.calls.push({ method, path, rawPath, body });

		const override = this.overrides.find(
			(candidate) =>
				candidate.path.test(url.pathname) &&
				(candidate.method === undefined || candidate.method === method),
		);
		if (override !== undefined) {
			override.times = (override.times ?? 1) - 1;
			if (override.times <= 0) {
				this.overrides.splice(this.overrides.indexOf(override), 1);
			}
			if (override.network) {
				throw new TypeError('fetch failed');
			}
			return this.respond(
				override.status,
				override.body ?? { message: 'overridden' },
				override.headers,
			);
		}
		if (url.pathname === this.graphqlPath) {
			return this.respond(
				200,
				this.graphql(body as { query: string; variables: Record<string, unknown> }),
			);
		}
		if (!url.pathname.startsWith(this.restPrefix)) {
			return this.respond(404, { message: `Outside the REST prefix: ${url.pathname}` });
		}
		return this.rest(method, new URL(url.pathname.slice(this.restPrefix.length), url.origin), body);
	}

	private respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
		this.rateLimitRemaining = Math.max(0, this.rateLimitRemaining - 1);
		return new Response(status === 204 ? null : JSON.stringify(body), {
			status,
			headers: {
				'content-type': 'application/json',
				'x-ratelimit-remaining': String(this.rateLimitRemaining),
				'x-ratelimit-reset': '1700000000',
				...headers,
			},
		});
	}

	private rest(method: string, url: URL, body: unknown): Response {
		const prefix = `/repos/${this.repo}`;
		if (!url.pathname.startsWith(prefix) && url.pathname !== '/user') {
			return this.respond(404, { message: 'Not Found' });
		}
		if (url.pathname === '/user') {
			return this.user === null
				? this.respond(403, { message: 'Resource not accessible by integration' })
				: this.respond(200, { login: this.user });
		}
		const rest = url.pathname.slice(prefix.length);
		let match: RegExpMatchArray | null;
		if (rest === '' && method === 'GET') {
			return this.respond(200, { default_branch: this.defaultBranch });
		}
		if ((match = rest.match(/^\/git\/ref\/(.+)$/)) && method === 'GET') {
			const ref = `refs/${decodeURIComponent(match[1] as string)}`;
			const entry = this.lookupRef(ref);
			return entry === undefined
				? this.respond(404, { message: 'Not Found' })
				: this.respond(200, { ref, object: { type: entry.type, sha: entry.sha } });
		}
		if ((match = rest.match(/^\/git\/tags\/(.+)$/)) && method === 'GET') {
			const nested =
				this.nestedTags.get(match[1] as string) ?? this.tagSource?.(match[1] as string);
			if (nested !== undefined && nested !== null) {
				return this.respond(200, { object: nested });
			}
			const entry = [...this.refs.values()].find((candidate) => candidate.sha === match?.[1]);
			return entry === undefined
				? this.respond(404, { message: 'Not Found' })
				: this.respond(200, { object: { type: 'commit', sha: entry.peeled } });
		}
		if (rest === '/git/refs' && method === 'POST') {
			const { ref, sha: target } = body as { ref: string; sha: string };
			if (this.refAt(ref) !== undefined) {
				return this.respond(422, { message: 'Reference already exists' });
			}
			this.writeRef(ref, target);
			return this.respond(201, { ref, object: { type: 'commit', sha: target } });
		}
		if ((match = rest.match(/^\/git\/refs\/(.+)$/)) && method === 'PATCH') {
			const ref = `refs/${decodeURIComponent(match[1] as string)}`;
			const current = this.refAt(ref);
			const { sha: target, force } = body as { sha: string; force: boolean };
			if (current === undefined) {
				return this.respond(422, { message: 'Reference does not exist' });
			}
			// GitHub enforces the fast-forward for branches only; every other ref rewinds silently, exactly as here.
			if (!force && ref.startsWith('refs/heads/') && !this.isAncestor(current, target)) {
				return this.respond(422, { message: 'Update is not a fast forward' });
			}
			this.writeRef(ref, target);
			return this.respond(200, { ref, object: { type: 'commit', sha: target } });
		}
		if ((match = rest.match(/^\/commits\/(.+)$/)) && method === 'GET') {
			const ref = decodeURIComponent(match[1] as string);
			const target =
				this.branches.get(ref) ??
				this.refs.get(`refs/tags/${ref}`)?.peeled ??
				(this.commits.has(ref) ? ref : undefined);
			return target === undefined
				? this.respond(422, { message: `No commit found for SHA: ${ref}` })
				: this.respond(200, { sha: target });
		}
		if ((match = rest.match(/^\/compare\/([^.]+)\.\.\.([^.]+)$/)) && method === 'GET') {
			const [, from, to] = match as unknown as [string, string, string];
			if (!this.commits.has(from) || !this.commits.has(to)) {
				return this.respond(404, { message: 'Not Found' });
			}
			const status =
				from === to
					? 'identical'
					: this.isAncestor(from, to)
						? 'ahead'
						: this.isAncestor(to, from)
							? 'behind'
							: 'diverged';
			const files: Array<{ filename: string; previous_filename?: string }> = (
				this.files.get(`${from}...${to}`) ?? []
			).map((filename) => ({ filename }));
			for (const [previous, current] of this.renames.get(`${from}...${to}`) ?? []) {
				files.push({ filename: current, previous_filename: previous });
			}
			return this.respond(200, { status, files });
		}
		if ((match = rest.match(/^\/pulls\/(\d+)$/)) && method === 'GET') {
			const pull = this.pulls.get(Number(match[1]));
			return pull === undefined
				? this.respond(404, { message: 'Not Found' })
				: this.respond(200, {
						number: pull.number,
						state: pull.state,
						merged: pull.merged,
						draft: pull.isDraft,
						head: { sha: pull.headSha },
						base: { ref: pull.baseRef },
						...(this.stacks ? { stack: restStack(pull) } : {}),
					});
		}
		if ((match = rest.match(/^\/statuses\/(.+)$/)) && method === 'POST') {
			const target = match[1] as string;
			const payload = body as {
				state: string;
				context: string;
				description: string;
				target_url: string | null;
			};
			if (
				(this.statuses.get(target) ?? []).filter((s) => s.context === payload.context).length >=
				1000
			) {
				return this.respond(422, {
					message: 'Validation Failed',
					errors: [
						{
							resource: 'Status',
							code: 'custom',
							message: 'This SHA and context has reached the maximum number of statuses.',
						},
					],
				});
			}
			this.status(target, {
				context: payload.context,
				state: payload.state,
				description: payload.description,
				targetUrl: payload.target_url,
				creator: this.creator,
			});
			return this.respond(201, { state: payload.state, creator: { login: this.creator } });
		}
		return this.respond(404, { message: `No route for ${method} ${url.pathname}` });
	}

	private graphql(request: { query: string; variables: Record<string, unknown> }): unknown {
		const { query, variables } = request;
		const context = variables['context'] as string;
		if (query.includes('object(oid:')) {
			const target = variables['oid'] as string;
			const status = this.latestStatus(target, context);
			return {
				data: {
					repository: {
						object: this.commits.has(target) ? { status: statusNode(status, query) } : null,
					},
				},
			};
		}
		if (query.includes('stack {') && !this.stacks) {
			return {
				errors: [
					{
						extensions: { code: 'undefinedField', typeName: 'PullRequest', fieldName: 'stack' },
						message: "Field 'stack' doesn't exist on type 'PullRequest'",
					},
				],
			};
		}
		if (query.includes('node(id:')) {
			const id = Number((variables['id'] as string).replace(/^STACK_/, ''));
			const cursor = typeof variables['cursor'] === 'string' ? Number(variables['cursor']) : 0;
			const exists = [...this.pulls.values()].some((pull) => pull.stack?.id === id);
			return { data: { node: exists ? { entries: this.stackEntries(id, cursor) } : null } };
		}
		if (query.includes('nodes(ids:')) {
			const ids = variables['ids'] as string[];
			return {
				data: {
					nodes: ids.map((id) => {
						const pull = this.pulls.get(Number(id.replace(/^PR_/, '')));
						return pull === undefined ? null : this.pullNode(pull, query, context);
					}),
				},
			};
		}
		const cursor = typeof variables['cursor'] === 'string' ? Number(variables['cursor']) : 0;
		const base = variables['base'] as string;
		let pulls = [...this.pulls.values()].filter((pull) => pull.baseRef === base);
		if (query.includes('states: MERGED')) {
			const label = variables['label'] as string;
			pulls = pulls.filter((pull) => pull.merged && pull.labels.includes(label));
		} else {
			pulls = pulls.filter((pull) => pull.state === 'open');
		}
		pulls.sort((a, b) => b.number - a.number);
		const size = query.includes('first: 50') ? Math.min(50, this.pageSize) : this.pageSize;
		const page = pulls.slice(cursor, cursor + size);
		const hasNextPage = cursor + size < pulls.length;
		return {
			data: {
				repository: {
					pullRequests: {
						pageInfo: { hasNextPage, endCursor: hasNextPage ? String(cursor + size) : null },
						nodes: page.map((pull) => ({
							...this.pullNode(pull, query, context),
							mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
						})),
					},
				},
			},
		};
	}

	private pullNode(pull: FakePull, query: string, context: string): Record<string, unknown> {
		return {
			number: pull.number,
			isDraft: pull.isDraft,
			headRefOid: pull.headSha,
			baseRefName: pull.baseRef,
			headRepository: pull.headRepo === null ? null : { nameWithOwner: pull.headRepo },
			commits: {
				nodes: [
					{ commit: { status: statusNode(this.latestStatus(pull.headSha, context), query) } },
				],
			},
			// Like GitHub, the stack is present only when the query selects it.
			...(query.includes('stack {') ? { stack: this.graphqlStack(pull) } : {}),
		};
	}

	private graphqlStack(pull: FakePull): unknown {
		if (pull.stack === null) {
			return null;
		}
		const { id, base } = pull.stack;
		return { id: `STACK_${id}`, baseRefName: base, entries: this.stackEntries(id, 0) };
	}

	/** One page of a stack's entries, `pageSize` at a time, as GitHub pages a connection. */
	private stackEntries(id: number, cursor: number): unknown {
		const members = [...this.pulls.values()]
			.filter((member) => member.stack?.id === id)
			.toSorted((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0));
		const page = members.slice(cursor, cursor + this.pageSize);
		const hasNextPage = cursor + this.pageSize < members.length;
		return {
			pageInfo: { hasNextPage, endCursor: hasNextPage ? String(cursor + this.pageSize) : null },
			nodes: page.map((member) => ({
				pullRequest: {
					id: `PR_${member.number}`,
					number: member.number,
					state: member.merged ? 'MERGED' : member.state.toUpperCase(),
				},
			})),
		};
	}
}

function restStack(pull: FakePull): unknown {
	return pull.stack === null
		? null
		: { id: pull.stack.id, base: { ref: pull.stack.base }, position: pull.stack.position };
}

function statusNode(status: FakeStatus | null, query: string): unknown {
	if (status === null) {
		return null;
	}
	// GitHub's GraphQL names a bot without its `[bot]` suffix and types it `Bot`; REST keeps the suffix.
	const bot = status.creator.endsWith('[bot]');
	const login = bot ? status.creator.slice(0, -'[bot]'.length) : status.creator;
	// Like GitHub, the typename is present only when the query selects it.
	const creator = query.includes('__typename')
		? { login, __typename: bot ? 'Bot' : 'User' }
		: { login };
	return {
		context: {
			state: status.state.toUpperCase(),
			description: status.description,
			targetUrl: status.targetUrl,
			creator,
		},
	};
}
