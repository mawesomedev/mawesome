import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A registry signing key as `https://registry.npmjs.org/-/npm/v1/keys` lists it (spec SEC-1). */
export interface RegistryKey {
	keyid: string;
	/** SPKI DER, base64. */
	key: string;
	expires: string | null;
	/** A revoked key never verifies anything, whatever the dates say. */
	revoked?: boolean;
}

/*
 * Append-only: a rotated key keeps its entry with `expires`; a compromised one gets `revoked: true`.
 * Snapshot of the registry listing taken on 2026-10-15.
 */
export const REGISTRY_KEYS: readonly RegistryKey[] = [
	{
		keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
		key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==',
		expires: '2025-01-29T00:00:00.000Z',
	},
	{
		keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
		key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
		expires: null,
	},
];

export const EXTRA_KEYS_FILE = 'keys.json';

/**
 * Keys added beside the built-in ones from `<home>/state/keys.json`, for registries that sign with their own keys.
 * Anything able to write there could replace the runtime itself, so this adds no trust the home does not already hold.
 */
export function loadKeyring(stateDir: string): RegistryKey[] {
	let extra: unknown;
	try {
		extra = JSON.parse(readFileSync(join(stateDir, EXTRA_KEYS_FILE), 'utf8'));
	} catch {
		return [...REGISTRY_KEYS];
	}
	const keys = Array.isArray(extra) ? extra : [];
	return [
		...REGISTRY_KEYS,
		...keys.filter(
			(key): key is RegistryKey =>
				typeof key === 'object' &&
				key !== null &&
				typeof (key as RegistryKey).keyid === 'string' &&
				typeof (key as RegistryKey).key === 'string' &&
				((key as RegistryKey).expires === null || typeof (key as RegistryKey).expires === 'string'),
		),
	];
}
