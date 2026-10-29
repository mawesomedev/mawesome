import { ConfigError } from '../config.ts';
import type { Ancestry, Logger, PrepareInput, PrepareResult } from '../types.ts';
import { BaselineError } from '../util.ts';
import { baselineRef } from '../refname.ts';
import {
	changedFiles,
	chunks,
	fetchMissingCommits,
	fetchRefs,
	GitError,
	hasCommit,
	isAncestor,
	lsRemote,
	type GitRepo,
} from './repo.ts';

export interface GitAncestryOptions {
	repo: GitRepo;
	logger: Logger;
	/** Never touch the network: a commit the clone lacks is an error rather than a fetch. */
	offline?: boolean;
}

/**
 * Ancestry through a treeless clone: no API quota, and the merge-base answer is exact.
 * It writes no refs: it reads what the remote advertises and fetches commits by SHA, so concurrent runs never collide.
 */
export function createGitAncestry(options: GitAncestryOptions): Ancestry {
	const { repo, logger } = options;
	// Offline, a commit the clone lacks is a configuration error; online it is fetched.
	const ensure = async (shas: string[]): Promise<void> => {
		if (!options.offline) {
			await fetchMissingCommits(repo, shas);
			return;
		}
		for (const sha of new Set(shas)) {
			if (!(await hasCommit(repo, sha))) {
				throw new ConfigError(`Offline: commit ${sha} is not in the clone.`);
			}
		}
	};
	return {
		name: 'git',
		async isAncestor(ancestor, descendant) {
			if (ancestor === descendant) {
				return true;
			}
			await ensure([ancestor, descendant]);
			return isAncestor(repo, ancestor, descendant);
		},
		async changedFiles(from, to) {
			if (from === to) {
				return [];
			}
			await ensure([from, to]);
			return changedFiles(repo, from, to);
		},
		async prepare(input: PrepareInput): Promise<PrepareResult> {
			await verifyRefs(repo, input.refs);
			const heads = input.pulls.length > 0 ? await fetchPullHeads(repo, input.pulls) : new Map();
			if (input.pulls.length > 0) {
				logger.info(
					`Fetched ${[...heads.values()].filter((oid) => oid !== null).length} PR heads treelessly.`,
				);
			}
			const optional = new Set(input.optional);
			await ensure(input.shas.filter((sha) => !optional.has(sha)));
			if (input.optional === undefined) {
				return { heads };
			}
			return { heads, missing: await fetchOptional(repo, [...optional], options.offline) };
		},
	};
}

/**
 * The API answer is authoritative; the remote's advertised baseline ref, peeled to its commit through `<ref>^{}`, must agree.
 * A disagreement in either direction means the baseline moved between the two reads, and the run must start over.
 */
async function verifyRefs(repo: GitRepo, refs: PrepareInput['refs']): Promise<void> {
	if (refs.length === 0) {
		return;
	}
	// The peeled entry is advertised only when asked for by its own `^{}` pattern.
	const remote = await lsRemote(
		repo,
		refs.flatMap((entry) => [baselineRef(entry.name), `${baselineRef(entry.name)}^{}`]),
	);
	const moved = refs.filter((entry) => {
		const ref = baselineRef(entry.name);
		const advertised = remote.get(`${ref}^{}`) ?? remote.get(ref) ?? null;
		return advertised !== entry.sha;
	});
	if (moved.length > 0) {
		throw new BaselineError(
			`Baseline ${moved.map((entry) => entry.name).join(', ')} differs between the API and the remote; it moved during this run, rerun to converge.`,
		);
	}
}

/** Git's wording for a ref or commit the remote no longer offers; anything else is a real failure. */
function isMissingOnRemote(error: unknown): boolean {
	return (
		error instanceof GitError &&
		/couldn't find remote ref|remote ref does not exist|not our ref/i.test(error.stderr)
	);
}

/** Fetches each commit on its own, so one the remote no longer serves is reported instead of thrown. */
async function fetchOptional(
	repo: GitRepo,
	shas: string[],
	offline: boolean | undefined,
): Promise<string[]> {
	const missing: string[] = [];
	for (const sha of shas) {
		if (await hasCommit(repo, sha)) {
			continue;
		}
		if (offline) {
			missing.push(sha);
			continue;
		}
		try {
			await fetchRefs(repo, [sha]);
		} catch (error) {
			if (!isMissingOnRemote(error)) {
				throw error;
			}
			missing.push(sha);
		}
	}
	return missing;
}

/**
 * Learns every open PR head from the remote and fetches the commits by SHA, in batches.
 * A failed batch is retried one SHA at a time; only a head the remote no longer offers yields null, anything else throws.
 */
export async function fetchPullHeads(
	repo: GitRepo,
	pulls: number[],
): Promise<Map<number, string | null>> {
	const heads = new Map<number, string | null>();
	const remote = await lsRemote(
		repo,
		pulls.map((number) => `refs/pull/${number}/head`),
	);
	for (const number of pulls) {
		heads.set(number, remote.get(`refs/pull/${number}/head`) ?? null);
	}
	const wanted = new Map<string, number[]>();
	for (const [number, sha] of heads) {
		if (sha !== null && !(await hasCommit(repo, sha))) {
			wanted.set(sha, [...(wanted.get(sha) ?? []), number]);
		}
	}
	// Only the batch that failed is retried one SHA at a time; the others stay a single round trip each.
	for (const batch of chunks([...wanted.keys()])) {
		try {
			await fetchRefs(repo, batch);
			continue;
		} catch (error) {
			if (!(error instanceof GitError)) {
				throw error;
			}
		}
		for (const sha of batch) {
			try {
				await fetchRefs(repo, [sha]);
			} catch (single) {
				if (!isMissingOnRemote(single)) {
					throw single;
				}
				for (const number of wanted.get(sha) ?? []) {
					heads.set(number, null);
				}
			}
		}
	}
	return heads;
}
