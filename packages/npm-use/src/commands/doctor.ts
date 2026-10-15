import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT } from '../errors.ts';
import { findProject } from '../project.ts';
import { listJournals } from '../state/journal.ts';
import { lockOwnerLive, lockPath, readLock } from '../state/lock.ts';
import { findNodeInstalls, linkState, readLinks } from '../setup/link.ts';
import { BOOTSTRAP_FILE, readCurrent, readManifest, versionDir } from '../setup/layout.ts';
import { readProfiles } from '../setup/profile.ts';
import { BLOCK_START, isShell, type Shell } from '../setup/shell.ts';
import { SELECTORS, SHIM_ABI, shimAbi, shimDir } from '../setup/shims.ts';
import { windowsWinners } from '../setup/windows.ts';
import type { CommandContext } from './context.ts';

export interface Problem {
	check: string;
	detail: string;
	fix: string;
}

export interface DoctorReport {
	home: string;
	version: string | null;
	problems: Problem[];
	notes: string[];
}

const PROBE_TIMEOUT_MS = 5000;

/** The `npm` an interactive login shell resolves, by asking that shell (its profiles decide the PATH). */
function shellWinner(shell: Shell, env: NodeJS.ProcessEnv): string | null {
	const bin = shell === 'powershell' ? 'pwsh' : shell;
	const args =
		shell === 'fish'
			? ['-l', '-i', '-c', 'command -v npm']
			: shell === 'powershell'
				? ['-NoProfile', '-Command', '(Get-Command npm).Source']
				: ['-l', '-i', '-c', 'command -v npm'];
	try {
		const out = execFileSync(bin, args, {
			encoding: 'utf8',
			env,
			timeout: PROBE_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.trim()
			.split('\n')
			.pop();
		return out === undefined || out === '' ? null : out;
	} catch {
		return null;
	}
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function collect(context: CommandContext): Promise<DoctorReport> {
	const { dirs, env, platform } = context;
	const report: DoctorReport = {
		home: dirs.home,
		version: readCurrent(dirs.home),
		problems: [],
		notes: [],
	};
	const setupHint = 'Run `npx --prefix ~ -y @mawesome/npm-use setup`.';
	const problem = (check: string, detail: string, fix: string): void => {
		report.problems.push({ check, detail, fix });
	};

	if (report.version === null || readManifest(dirs.home, report.version) === null) {
		problem('runtime', `no runtime is installed under ${dirs.home}`, setupHint);
	} else {
		const root = join(dirs.home, BOOTSTRAP_FILE);
		const shipped = join(versionDir(dirs.home, report.version), BOOTSTRAP_FILE);
		if (!existsSync(root) || !readFileSync(root).equals(readFileSync(shipped))) {
			problem('launcher', `${root} differs from the installed version's launcher`, setupHint);
		}
	}
	for (const name of SELECTORS) {
		const file = join(shimDir(dirs.home), name);
		const abi = existsSync(file) ? shimAbi(readFileSync(file, 'utf8')) : null;
		if (abi === null) {
			problem('shims', `${file} is missing or not an npm-use shim`, setupHint);
		} else if (abi !== SHIM_ABI) {
			problem(
				'shims',
				`${file} declares launcher ABI ${abi}, this version needs ${SHIM_ABI}`,
				setupHint,
			);
		}
	}
	if (dirs.machine.fallback) {
		report.notes.push(
			'The machine id falls back to the hostname; cloned machines or containers sharing this home could collide in the cache.',
		);
	}
	const lock = readLock(dirs.state);
	if (lock !== null && !lockOwnerLive(lock, dirs.machine.id)) {
		problem(
			'lock',
			`${lockPath(dirs.state)} is held by PID ${lock.pid}, which no longer runs`,
			`Delete ${lockPath(dirs.state)}.`,
		);
	}
	for (const journal of listJournals(dirs.journal)) {
		const foreign = journal.owner.machineId !== dirs.machine.id;
		problem(
			'journal',
			`${journal.id} (${journal.kind}) for ${journal.target} was left by ${foreign ? `another machine (${journal.owner.host})` : `PID ${journal.owner.pid}`}`,
			foreign
				? `Confirm no npm-use runs on ${journal.owner.host}, then run \`npm-use recover --journal ${journal.id} --confirm-dead-machine ${journal.owner.machineId}\`.`
				: 'Run any npm-use command; dead owners are recovered automatically.',
		);
	}

	const profiles = readProfiles(dirs);
	for (const entry of profiles.entries) {
		if (!existsSync(entry.file) || !readFileSync(entry.file, 'utf8').includes(BLOCK_START)) {
			problem(
				'profile',
				`${entry.file} no longer holds the npm-use block`,
				`Run \`npm-use init ${entry.shell}\` and add the block, or run setup again.`,
			);
		}
	}
	const shimsDir = shimDir(dirs.home);
	if (platform === 'win32') {
		for (const winner of windowsWinners(env)) {
			if (winner.path === null || !winner.path.toLowerCase().startsWith(shimsDir.toLowerCase())) {
				problem(
					'path',
					`${winner.context} resolves npm to ${winner.path ?? 'nothing'}`,
					'Run setup again, then restart the terminal (M-RESTART).',
				);
			}
		}
	} else {
		const login = basename(env['SHELL'] ?? '');
		const shells = new Set<Shell>([
			...profiles.entries.map((entry) => entry.shell),
			...(isShell(login) ? [login] : []),
		]);
		for (const shell of shells) {
			if (shell === 'powershell') {
				continue;
			}
			const winner = shellWinner(shell, env);
			if (winner === null) {
				continue;
			}
			if (!samePath(winner, join(shimsDir, 'npm'), platform)) {
				const corepack = winner.includes('corepack') ? ' (a Corepack shim)' : '';
				problem(
					'path',
					`${shell} resolves npm to ${winner}${corepack}`,
					`Add the snippet from \`npm-use init ${shell}\` after your Node manager's init line, or run setup with --link.`,
				);
			}
		}
	}

	const links = readLinks(dirs);
	if (links.entries.length > 0) {
		for (const entry of links.entries) {
			const state = linkState(entry);
			if (state !== 'intact') {
				problem(
					'link',
					`${entry.target} is ${state === 'missing' ? 'missing' : 'no longer the npm-use shim'}`,
					'Run `npm-use setup --link` to relink, or `npm-use uninstall` to stop linking.',
				);
			}
		}
		const linked = new Set(links.entries.map((entry) => entry.binDir));
		for (const install of findNodeInstalls(env, platform)) {
			if (!linked.has(install.binDir)) {
				problem(
					'link',
					`${install.manager} ${install.version} at ${install.binDir} is not linked`,
					'Run `npm-use setup --link`.',
				);
			}
		}
	}
	report.notes.push(
		...findNodeInstalls(env, platform).map(
			(install) => `Found ${install.manager} ${install.version} at ${install.binDir}`,
		),
	);

	const project = findProject([], process.cwd(), env);
	if (existsSync(join(project.root, 'node_modules', '.bin', 'npm'))) {
		report.notes.push(
			`${project.root}/node_modules/.bin/npm exists; npm scripts in this project run it instead of the shim.`,
		);
	}
	return report;
}

export async function doctor(
	context: CommandContext,
	options: { quiet?: boolean } = {},
): Promise<number> {
	const report = await collect(context);
	if (options.quiet) {
		return report.problems.length === 0 ? EXIT.ok : EXIT.problems;
	}
	if (context.json) {
		context.io.out(JSON.stringify(report, null, 2));
	} else {
		const lines = [`npm-use ${report.version ?? '(not installed)'} in ${report.home}`];
		for (const problem of report.problems) {
			lines.push(`  problem [${problem.check}]: ${problem.detail}`, `    fix: ${problem.fix}`);
		}
		for (const note of report.notes) {
			lines.push(`  note: ${note}`);
		}
		lines.push(
			report.problems.length === 0 ? '  healthy' : `  ${report.problems.length} problem(s)`,
		);
		context.io.out(lines.join('\n'));
	}
	return report.problems.length === 0 ? EXIT.ok : EXIT.problems;
}
