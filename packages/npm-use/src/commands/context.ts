import { createInterface } from 'node:readline/promises';
import { resolveDirs, type Dirs } from '../setup/home.ts';
import { ownerRecord, type OwnerRecord } from '../state/lease.ts';

export interface CommandIo {
	out(text: string): void;
	err(text: string): void;
	/** Asks a yes/no question; a non-interactive session answers no. */
	confirm(question: string): Promise<boolean>;
	interactive: boolean;
}

export interface CommandContext {
	dirs: Dirs;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	owner: OwnerRecord;
	io: CommandIo;
	json: boolean;
	version: string;
}

export interface ContextOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	json?: boolean;
	io?: CommandIo;
	version: string;
}

export function terminalIo(): CommandIo {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	return {
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
		interactive,
		async confirm(question) {
			if (!interactive) {
				return false;
			}
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				const answer = await rl.question(`${question} [y/N] `);
				return /^y(es)?$/i.test(answer.trim());
			} finally {
				rl.close();
			}
		},
	};
}

export function createCommandContext(options: ContextOptions): CommandContext {
	const env = options.env ?? process.env;
	const dirs = resolveDirs(env, options.home);
	return {
		dirs,
		env,
		platform: process.platform,
		owner: ownerRecord(dirs.machine.id),
		io: options.io ?? terminalIo(),
		json: options.json ?? false,
		version: options.version,
	};
}
