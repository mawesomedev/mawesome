import { run } from '../../src/commands/dispatch.ts';
import type { CommandIo } from '../../src/commands/context.ts';

export interface CommandRun {
	code: number;
	stdout: string;
	stderr: string;
	questions: string[];
}

/** Runs an npm-vm command in-process with captured output and scripted answers. */
export async function command(
	argv: string[],
	options: {
		home: string;
		env: NodeJS.ProcessEnv;
		cwd?: string;
		answers?: boolean[];
		/** Runs while a prompt is open, before its answer: what a user does meanwhile. */
		onQuestion?: (question: string) => void;
	},
): Promise<CommandRun> {
	const result: CommandRun = { code: -1, stdout: '', stderr: '', questions: [] };
	const answers = [...(options.answers ?? [])];
	const io: CommandIo = {
		out: (text) => {
			result.stdout += `${text}\n`;
		},
		err: (text) => {
			result.stderr += `${text}\n`;
		},
		interactive: answers.length > 0,
		async confirm(question) {
			result.questions.push(question);
			options.onQuestion?.(question);
			return answers.shift() ?? false;
		},
	};
	const previous = process.cwd();
	if (options.cwd !== undefined) {
		process.chdir(options.cwd);
	}
	try {
		result.code = await run(argv, { home: options.home, env: options.env, io });
	} finally {
		process.chdir(previous);
	}
	return result;
}
