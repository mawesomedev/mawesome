import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT, NpmVmError } from '../errors.ts';
import { dirPermsMessage, restartMessage } from '../messages.ts';
import { recoverDeadJournals, mutateFile } from '../state/journal.ts';
import { acquireLock } from '../state/lock.ts';
import { findNodeInstalls, linkOne, linkTargets, type LinkResult } from '../setup/link.ts';
import {
	BOOTSTRAP_FILE,
	installBootstrap,
	installVersion,
	readCurrent,
	readManifest,
	runtimeDistDir,
	setCurrent,
	sweepReplaced,
	versionDir,
} from '../setup/layout.ts';
import {
	applyProfileEdit,
	executionPolicy,
	planProfileEdit,
	profileGuard,
	profileTargets,
	type ProfileTarget,
} from '../setup/profile.ts';
import { isShell, profileBlock, type Shell } from '../setup/shell.ts';
import {
	assertSafeHome,
	renderShims,
	SHIM_ABI,
	shimDir,
	stalePowershellShims,
} from '../setup/shims.ts';
import { addToUserPath, powershellAllowsScripts, setCmdAutoRun } from '../setup/windows.ts';
import type { CommandContext } from './context.ts';
import { doctor } from './doctor.ts';

export interface SetupOptions {
	link: boolean;
	shells: Shell[] | null;
	yes: boolean;
	dryRun: boolean;
	modifyProfile: boolean;
	cmdAutorun: boolean;
	strict: boolean;
	/** Write the Windows user PATH and AutoRun; the Action turns this off and relies on GITHUB_PATH. */
	userPath: boolean;
}

export interface SetupReport {
	home: string;
	version: string;
	profiles: Array<{
		file: string;
		outcome: 'written' | 'unchanged' | 'printed' | 'declined' | 'changed' | 'dry-run';
		reason?: string;
	}>;
	links: LinkResult[];
	skipped: number;
}

/** Refuses a home or cache another user could write to (spec SEC-9). */
export function assertPrivateDir(dir: string, platform: NodeJS.Platform): void {
	if (platform === 'win32') {
		return;
	}
	const stat = statSync(dir);
	if (process.getuid !== undefined && stat.uid !== process.getuid()) {
		throw new NpmVmError(
			'M-DIRPERMS',
			EXIT.problems,
			dirPermsMessage(dir, 'is not owned by you', `chown $(id -u) ${dir}`),
		);
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new NpmVmError(
			'M-DIRPERMS',
			EXIT.problems,
			dirPermsMessage(dir, 'is writable by other users', `chmod go-w ${dir}`),
		);
	}
}

function ensurePrivateDir(dir: string, platform: NodeJS.Platform): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (platform !== 'win32') {
			chmodSync(dir, 0o700);
		}
	}
	assertPrivateDir(dir, platform);
}

/** The shells to configure: `--shell` values, else the login shell, plus PowerShell on Windows. */
export function defaultShells(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Shell[] {
	if (platform === 'win32') {
		return ['powershell'];
	}
	const login = basename(env['SHELL'] ?? '');
	return isShell(login) ? [login] : ['bash'];
}

function sameFiles(home: string, version: string, distDir: string): boolean {
	const manifest = readManifest(home, version);
	if (manifest === null) {
		return false;
	}
	return manifest.files.every((file) => {
		try {
			return readFileSync(join(distDir, file)).equals(
				readFileSync(join(versionDir(home, version), file)),
			);
		} catch {
			return false;
		}
	});
}

export async function setup(context: CommandContext, options: SetupOptions): Promise<number> {
	const { dirs, env, platform, io } = context;
	assertSafeHome(dirs.home);
	const distDir = runtimeDistDir();
	if (distDir === null) {
		throw new NpmVmError(
			'M-ABI',
			EXIT.problems,
			'This npm-vm installation ships no runtime build; reinstall the package.',
		);
	}
	for (const dir of [dirs.home, dirs.state, dirs.cache]) {
		if (options.dryRun) {
			if (existsSync(dir)) {
				assertPrivateDir(dir, platform);
			}
		} else {
			ensurePrivateDir(dir, platform);
		}
	}
	const report: SetupReport = {
		home: dirs.home,
		version: context.version,
		profiles: [],
		links: [],
		skipped: 0,
	};
	const shells = options.shells ?? defaultShells(env, platform);
	const targets = options.modifyProfile ? profileTargets(shells, env, platform) : [];
	const policy = platform === 'win32' ? executionPolicy(env) : null;
	const powershell = platform !== 'win32' || powershellAllowsScripts(policy);

	// Every target is examined before anything is written, so a refusal costs nothing.
	const plans = targets.map((target) => ({
		target,
		guard: profileGuard(target.file, env, platform),
		edit: planProfileEdit(target, dirs.home),
	}));

	// A dry run writes nothing, not even the lock, so the home stays absent when it did not exist.
	const lock = options.dryRun ? null : await acquireLock(dirs.state, context.owner);
	try {
		if (lock !== null) {
			recoverDeadJournals(dirs.journal, dirs.machine.id);
		}
		if (!options.dryRun) {
			installRuntime(context, distDir);
			mkdirSync(shimDir(dirs.home), { recursive: true, mode: 0o755 });
			for (const file of renderShims(dirs.home, platform, { powershell })) {
				mutateFile(
					dirs.journal,
					'launcher',
					context.owner,
					join(shimDir(dirs.home), file.name),
					Buffer.from(file.content),
					file.mode,
				);
			}
			if (platform === 'win32' && !powershell) {
				for (const stale of stalePowershellShims(dirs.home)) {
					mutateFile(dirs.journal, 'launcher', context.owner, stale, null);
				}
			}
		}
		for (const plan of plans) {
			report.profiles.push(await applyPlan(context, options, plan));
		}
		if (options.link) {
			for (const install of findNodeInstalls(env, platform)) {
				for (const target of linkTargets(dirs.home, platform, powershell)) {
					if (options.dryRun) {
						report.links.push({
							target: join(install.binDir, target.name),
							outcome: 'linked',
							detail: 'dry run',
						});
					} else {
						report.links.push(linkOne(dirs, context.owner, install.binDir, target));
					}
				}
			}
		}
		if (platform === 'win32' && !options.dryRun && options.userPath) {
			if (addToUserPath(env, shimDir(dirs.home))) {
				env['Path'] = `${shimDir(dirs.home)};${env['Path'] ?? ''}`;
				io.err(restartMessage());
			}
			if (options.cmdAutorun) {
				setCmdAutoRun(env, shimDir(dirs.home));
			}
			if (!powershell) {
				io.err(
					`PowerShell's execution policy (${policy ?? 'unknown'}) blocks unsigned scripts, so no .ps1 shims were installed; cmd shims take over.`,
				);
			}
		}
	} finally {
		lock?.release();
	}
	report.skipped =
		report.profiles.filter(
			(entry) =>
				entry.outcome === 'printed' || entry.outcome === 'declined' || entry.outcome === 'changed',
		).length +
		report.links.filter((link) => ['foreign', 'unwritable', 'missing'].includes(link.outcome))
			.length;
	if (context.json) {
		io.out(JSON.stringify(report, null, 2));
	} else {
		io.out(describe(report));
	}
	if (!options.dryRun) {
		// With --json the setup report is the only document on stdout; doctor still decides --strict.
		const health = await doctor(context, { quiet: context.json });
		if (health !== EXIT.ok && options.strict) {
			return EXIT.partial;
		}
	}
	return options.strict && report.skipped > 0 ? EXIT.partial : EXIT.ok;
}

/** Installs this version's runtime and launcher unless the identical files are already in place. */
function installRuntime(context: CommandContext, distDir: string): void {
	const { dirs, version } = context;
	if (!sameFiles(dirs.home, version, distDir)) {
		installVersion(dirs.home, version, distDir, SHIM_ABI);
	}
	sweepReplaced(dirs.home);
	if (readCurrent(dirs.home) !== version) {
		mutateFile(
			dirs.journal,
			'launcher',
			context.owner,
			join(dirs.home, 'current'),
			Buffer.from(`${version}\n`),
		);
	}
	const bootstrap = readFileSync(join(versionDir(dirs.home, version), BOOTSTRAP_FILE));
	const installed = existsSync(join(dirs.home, BOOTSTRAP_FILE))
		? readFileSync(join(dirs.home, BOOTSTRAP_FILE))
		: null;
	if (installed === null || !installed.equals(bootstrap)) {
		mutateFile(
			dirs.journal,
			'launcher',
			context.owner,
			join(dirs.home, BOOTSTRAP_FILE),
			bootstrap,
			0o644,
		);
	}
	void setCurrent;
	void installBootstrap;
}

async function applyPlan(
	context: CommandContext,
	options: SetupOptions,
	plan: { target: ProfileTarget; guard: string | null; edit: ReturnType<typeof planProfileEdit> },
): Promise<SetupReport['profiles'][number]> {
	const { io, dirs } = context;
	const { target } = plan;
	if (plan.guard !== null) {
		io.out(
			`Not editing ${target.file}: ${plan.guard}. Add this yourself:\n${profileBlock(target.shell, dirs.home, target.parts)}`,
		);
		return { file: target.file, outcome: 'printed', reason: plan.guard };
	}
	if (plan.edit === null) {
		return { file: target.file, outcome: 'unchanged' };
	}
	if (options.dryRun) {
		io.out(`Would edit ${target.file}:\n${plan.edit.diff}`);
		return { file: target.file, outcome: 'dry-run' };
	}
	if (!options.yes) {
		io.out(plan.edit.diff);
		const agreed = await io.confirm(`Apply this change to ${target.file}?`);
		if (!agreed) {
			io.out(
				`Skipped ${target.file}. Add this yourself:\n${profileBlock(target.shell, dirs.home, target.parts)}`,
			);
			return { file: target.file, outcome: 'declined' };
		}
	}
	// The file may have changed while the prompt was open: plan again, and never write over what was not shown.
	const fresh = planProfileEdit(target, dirs.home);
	if (fresh === null) {
		return { file: target.file, outcome: 'unchanged' };
	}
	if (fresh.before !== plan.edit.before && !options.yes) {
		io.out(
			`${target.file} changed while the prompt was open; run setup again to review the new change.`,
		);
		return { file: target.file, outcome: 'changed' };
	}
	applyProfileEdit(dirs, context.owner, fresh);
	return { file: target.file, outcome: 'written' };
}

function describe(report: SetupReport): string {
	const lines = [`npm-vm ${report.version} installed in ${report.home}`];
	for (const profile of report.profiles) {
		lines.push(
			`  ${profile.file}: ${profile.outcome}${profile.reason ? ` (${profile.reason})` : ''}`,
		);
	}
	for (const link of report.links) {
		lines.push(`  ${link.target}: ${link.outcome}${link.detail ? ` (${link.detail})` : ''}`);
	}
	return lines.join('\n');
}
