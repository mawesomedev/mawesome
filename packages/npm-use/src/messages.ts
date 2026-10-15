import type { NpmSpec } from './spec.ts';

/** Message builders for spec section 12; every message names the cause and one fix. */

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
		`Run \`npm-use which\` to see the resolution.`,
	].join('\n');
}

export function transportMessage(ownVersion: string | null, detail: string): string {
	const found =
		ownVersion === null ? 'no npm beside the active Node' : `Node's own npm ${ownVersion}`;
	return [
		`Cannot download npm: ${found} (${detail}); npm 8 or newer is needed as the transport.`,
		`Reinstall Node or run \`npm-use install <version>\` from a Node whose npm works.`,
	].join('\n');
}

export function keyMessage(keyid: string): string {
	return [
		`The registry signed npm with key ${keyid}, which npm-use does not know.`,
		`Run \`npm-use self-update\` to pick up new registry keys.`,
	].join('\n');
}

export function unsignedMessage(registry: string, version: string): string {
	return [
		`${registry} serves npm ${version} without a registry signature.`,
		`Pin a tarball hash in devEngines.packageManager (\`${version}+sha512.<hex>\`) to allow unsigned registries.`,
	].join('\n');
}

export function integrityMessage(expected: string, actual: string, detail: string): string {
	return [
		`npm tarball verification failed: ${detail}.`,
		`Expected ${expected}, got ${actual}. Clear the entry with \`npm-use cache prune\` and retry.`,
	].join('\n');
}

export function oldNodeMessage(nodeVersion: string, floor: string, requirement: string): string {
	return `npm-use: Node ${nodeVersion} is below ${floor}; running Node's own npm and ignoring the project requirement ${requirement}. Upgrade Node to honour it.`;
}

export function abiMessage(detail: string): string {
	return [
		`npm-use launcher mismatch: ${detail}.`,
		`Run \`npx --prefix ~ -y @mawesome/npm-use setup\` to reinstall the launchers.`,
	].join('\n');
}
