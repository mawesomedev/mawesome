import type { NpmSpec } from './spec.ts';

/** Message builders for spec section 12; every message names the cause and one fix. */

/** Every URL in `text` with its user info replaced, so a registry token never reaches a terminal (spec SEC-10). */
export function redactUrls(text: string): string {
	return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/]*)@/gi, '$1***@');
}

export function describeSpecs(specs: readonly NpmSpec[]): string {
	return specs
		.map((spec) =>
			spec.hash ? `${spec.exact}+${spec.hash.algorithm}.${spec.hash.hex.slice(0, 8)}…` : spec.range,
		)
		.join(' or ');
}

export function engineMessage(version: string, enginesNode: string, nodeVersion: string): string {
	return [
		`npm ${version} needs Node ${enginesNode}, but the active Node is ${nodeVersion}.`,
		`Switch Node with \`nvm install <version>\` or \`fnm use <version>\`, or relax the npm range in package.json.`,
	].join('\n');
}

export function noMatchMessage(specs: readonly NpmSpec[], file: string, reason: string): string {
	return [
		`No npm version satisfies ${describeSpecs(specs)} (${file}): ${reason}.`,
		`Run \`npm-vm which\` to see the resolution.`,
	].join('\n');
}

export function transportMessage(ownVersion: string | null, detail: string): string {
	const found =
		ownVersion === null ? 'no npm beside the active Node' : `Node's own npm ${ownVersion}`;
	return [
		`Cannot download npm: ${found} (${detail}); npm 8 or newer is needed as the transport.`,
		`Reinstall Node or run \`npm-vm install <version>\` from a Node whose npm works.`,
	].join('\n');
}

export function keyMessage(keyid: string): string {
	return [
		`The registry signed npm with key ${keyid}, which npm-vm does not know.`,
		`Run \`npm-vm self-update\` to pick up new registry keys.`,
	].join('\n');
}

export function unsignedMessage(registry: string, version: string): string {
	return [
		`${redactUrls(registry)} serves npm ${version} without a registry signature.`,
		`Pin a tarball hash in devEngines.packageManager (\`${version}+sha512.<hex>\`) to allow unsigned registries.`,
	].join('\n');
}

export function integrityMessage(expected: string, actual: string, detail: string): string {
	return [
		`npm tarball verification failed: ${detail}.`,
		`Expected ${expected}, got ${actual}. Clear the entry with \`npm-vm cache prune\` and retry.`,
	].join('\n');
}

export function oldNodeMessage(nodeVersion: string, floor: string, requirement: string): string {
	return `npm-vm: Node ${nodeVersion} is below ${floor}; running Node's own npm and ignoring the project requirement ${requirement}. Upgrade Node to honour it.`;
}

export function abiMessage(detail: string): string {
	return [
		`npm-vm launcher mismatch: ${detail}.`,
		`Run \`npx --prefix ~ -y @mawesome/npm-vm setup\` to reinstall the launchers.`,
	].join('\n');
}

export interface LockHolder {
	pid: number;
	host: string;
	createdAt: string;
}

/** M-LOCKED: names the file, the holder, and the one recovery that is safe for where the holder runs. */
export function lockedMessage(
	path: string,
	holder: LockHolder | null,
	live: boolean,
	foreign: boolean,
): string {
	if (holder === null) {
		return `${path} is locked by an unreadable owner. If no npm-vm command is running, delete that file and retry.`;
	}
	const who = `PID ${holder.pid} on ${holder.host} since ${holder.createdAt || 'an unknown time'}`;
	if (foreign) {
		return [
			`${path} is locked by ${who}, which cannot be verified from this machine.`,
			`Confirm on ${holder.host} that no npm-vm command runs, then delete ${path} and retry.`,
		].join('\n');
	}
	if (live) {
		return `${path} is locked by ${who}, which is still running. Wait for it to finish and retry.`;
	}
	return `${path} is locked by ${who}, which is no longer running. Delete ${path} and retry.`;
}

export function provenanceMessage(name: string, version: string, detail: string): string {
	return [
		`${name}@${version} failed provenance verification: ${detail}.`,
		'The installed version is unchanged. Retry later, or install the release by hand after checking it at https://www.npmjs.com/package/@mawesome/npm-vm.',
	].join('\n');
}

export function dirPermsMessage(dir: string, problem: string, fix: string): string {
	return [
		`${dir} ${problem}.`,
		`Run \`${fix}\` and retry, or point NPM_VM_HOME at a private directory.`,
	].join('\n');
}

export function changedMessage(file: string, what: string): string {
	return `${file} changed since npm-vm wrote it; left untouched. Remove the ${what} by hand if you still want it gone.`;
}

export function restartMessage(): string {
	return 'Restart open terminals and IDEs so they pick up the new PATH.';
}
