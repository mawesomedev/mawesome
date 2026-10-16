/** Exit codes of `npm-vm` itself and of the shim before npm starts (spec section 10). */
export const EXIT = {
	ok: 0,
	problems: 1,
	partial: 2,
	resolution: 3,
	transport: 4,
	verification: 5,
	abi: 6,
	usage: 64,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure with a message id from spec section 12 and the exit code it maps to. */
export class NpmVmError extends Error {
	override name = 'NpmVmError';
	readonly id: string;
	readonly exitCode: ExitCode;

	constructor(id: string, exitCode: ExitCode, message: string) {
		super(message);
		this.id = id;
		this.exitCode = exitCode;
	}
}

export function isNpmVmError(error: unknown): error is NpmVmError {
	return error instanceof NpmVmError;
}
