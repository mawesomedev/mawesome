import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, type RegistryProvider } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const depsRoot = join(here, 'fixtures', 'deps');
const targetsRoot = join(here, 'fixtures', 'targets');

const fixtureProvider: RegistryProvider = {
	async materialize(name, _range, intoDir) {
		const src = join(depsRoot, name);
		if (!existsSync(src)) {
			return undefined;
		}
		cpSync(src, join(intoDir, 'node_modules', name), { recursive: true });
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { version?: string };
		return pkg.version;
	},
};

const run = (name: string) => audit(join(targetsRoot, name), { provider: fixtureProvider });

describe('audit (type-surface coverage notices)', () => {
	it('notices when declared types do not resolve (build output missing)', async () => {
		const result = await run('types-not-built');
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toMatchObject({ kind: 'types-not-built', surface: 'types' });
		// A coverage gap is a notice, not a finding — the audit still "passes".
		expect(result.findings).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('notices when `exports` hides a built `types` directory field', async () => {
		const result = await run('types-ignored-by-exports');
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toMatchObject({ kind: 'types-ignored-by-exports', surface: 'types' });
		expect(result.ok).toBe(true);
	});

	it('still notices a missing build when `exports` is present and the `types` field is unbuilt', async () => {
		const result = await run('types-exports-not-built');
		expect(result.notices[0]).toMatchObject({ kind: 'types-not-built', surface: 'types' });
	});

	it('notices when shipped .d.ts files are not exposed by the manifest', async () => {
		const result = await run('types-unreachable');
		expect(result.notices[0]).toMatchObject({ kind: 'types-unreachable', surface: 'types' });
	});

	it('emits no notice when the type surface is fully covered', async () => {
		const result = await run('clean');
		expect(result.notices).toEqual([]);
	});

	it('emits no notice for a package that legitimately declares no types', async () => {
		const result = await run('runtime-ok');
		expect(result.notices).toEqual([]);
	});
});
