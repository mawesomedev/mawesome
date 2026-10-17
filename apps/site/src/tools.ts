/**
 * The tool registry — the single source of truth for which @mawesome/* tools the site presents.
 * Drives doc aggregation (scripts/sync-docs.ts), the Starlight sidebar (astro.config.ts), and the
 * homepage cards. Add a tool here (with a `packages/<slug>/docs/` directory) to surface it everywhere.
 */
import type { StarlightIcon } from '@astrojs/starlight/types';

export interface Tool {
	/** Route base and the `packages/<slug>` / `src/content/docs/<slug>` directory name. */
	slug: string;
	/** Display name (homepage card, sidebar group). */
	name: string;
	/** npm package name, e.g. for install snippets. */
	npm: string;
	/** One-line blurb for the homepage card. */
	tagline: string;
	/** Starlight icon name for the card (see https://starlight.astro.build/reference/icons/). */
	icon: StarlightIcon;
	/** Shell snippet the homepage card offers to copy. */
	quickstart: string;
	/** Whether the tool ships an interactive in-browser playground (Phase 3 wires the route). */
	playground: boolean;
	/**
	 * Sidebar order of the tool's doc files, as basenames without `.md` and excluding `README`
	 * (always the section index). Files not listed sort after these, alphabetically.
	 */
	docOrder: string[];
}

export const tools: Tool[] = [
	{
		slug: 'dependency-audit',
		name: 'dependency-audit',
		npm: '@mawesome/dependency-audit',
		tagline:
			"Verify every reachable import in a package's released artifact is declared and resolvable through its dependencies.",
		icon: 'magnifier',
		quickstart: 'npx @mawesome/dependency-audit lodash@4.17.21',
		playground: true,
		docOrder: [
			'get-started',
			'concepts',
			'why',
			'cli',
			'output-format',
			'findings',
			'api',
			'resolution',
			'limitations',
			'security',
			'comparison',
		],
	},
	{
		slug: 'npm-vm',
		name: 'npm-vm',
		npm: '@mawesome/npm-vm',
		tagline: 'Run the npm version a project declares in devEngines, whatever Node is active.',
		icon: 'setting',
		quickstart: 'npx --prefix ~ -y @mawesome/npm-vm setup',
		playground: false,
		docOrder: ['get-started', 'how-it-works', 'cli', 'shells', 'security', 'action'],
	},
	{
		slug: 'pr-baseline',
		name: 'pr-baseline',
		npm: '@mawesome/pr-baseline',
		tagline:
			'Keep open pull requests current with a movable baseline on the base branch, reported through commit statuses.',
		icon: 'approve-check',
		quickstart: 'export GITHUB_TOKEN=…\nnpx @mawesome/pr-baseline report --repo owner/name',
		playground: false,
		docOrder: [
			'concepts',
			'cli',
			'api',
			'permissions',
			'rate-limits',
			'edge-cases',
			'runbook',
			'for-pr-authors',
			'action',
		],
	},
];

/** A GitHub Action from `actions/<dir>`, released to its own mirror repository. */
export interface Action {
	/** Mirror repository consumers reference in `uses:`, e.g. `mawesomedev/pr-baseline-action`. */
	repo: string;
	/** Workspace package name, read for the released version (mirror tags are `v<version>`). */
	workspace: string;
	/** One-line blurb for the homepage card. */
	tagline: string;
	/** Starlight icon name for the card. */
	icon: StarlightIcon;
	/** Site route of the action's docs page. */
	docs: string;
}

export const actions: Action[] = [
	{
		repo: 'mawesomedev/npm-vm-action',
		workspace: '@mawesome/npm-vm-action',
		tagline: 'Give a job the npm its project declares, verified and cached between runs.',
		icon: 'github',
		docs: '/npm-vm/action/',
	},
	{
		repo: 'mawesomedev/pr-baseline-action',
		workspace: '@mawesome/pr-baseline-action',
		tagline:
			'Run pr-baseline on pull requests, merges, pushes and a schedule, writing one commit status per PR.',
		icon: 'github',
		docs: '/pr-baseline/action/',
	},
];
