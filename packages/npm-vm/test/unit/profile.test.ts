import { shellBinary } from '../../src/state/proc.ts';
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDirs } from '../../src/setup/home.ts';
import {
	applyProfileEdit,
	planProfileEdit,
	profileGuard,
	profileTargets,
	readProfiles,
	removeProfileBlock,
	withBlock,
	withoutBlock,
} from '../../src/setup/profile.ts';
import { profileBlock } from '../../src/setup/shell.ts';
import { ownerRecord } from '../../src/state/lease.ts';
import { makeTree, removeTrees } from '../helpers/tree.ts';

afterEach(removeTrees);

const owner = ownerRecord('m');

function dirsIn(root: string) {
	return resolveDirs({}, join(root, 'home'), 'linux', { id: 'm', fallback: false });
}

describe('profileTargets', () => {
	it('names the files per shell, honouring ZDOTDIR and the bash login file', () => {
		const home = makeTree({ '.bash_login': '', zdot: {} });
		const zsh = profileTargets(['zsh'], { ZDOTDIR: join(home, 'zdot') }, 'linux', home);
		expect(zsh.map((target) => [target.file, target.parts])).toEqual([
			[join(home, 'zdot', '.zshenv'), { path: true, hook: false }],
			[join(home, 'zdot', '.zshrc'), { path: false, hook: true }],
		]);
		const bash = profileTargets(['bash'], {}, 'linux', home);
		expect(bash.map((target) => target.file)).toEqual([
			join(home, '.bashrc'),
			join(home, '.bash_login'),
		]);
		const fish = profileTargets(['fish'], {}, 'linux', home);
		expect(fish[0]?.file).toBe(join(home, '.config', 'fish', 'conf.d', 'npm-vm.fish'));
		// pwsh is found through the system dirs, never PATH: present or not, the answer never depends on PATH.
		const pwsh = profileTargets(['powershell'], { PATH: '/nonexistent' }, 'linux', home);
		expect(pwsh).toEqual(
			shellBinary('powershell', {}, 'linux') === null
				? []
				: [expect.objectContaining({ shell: 'powershell' })],
		);
	});
});

describe('withBlock', () => {
	it('appends after a blank line, replaces an existing block, and removes cleanly', () => {
		const block = '# >>> npm-vm >>>\nexport X=1\n# <<< npm-vm <<<\n';
		expect(withBlock(null, block)).toBe(block);
		expect(withBlock('alias ls=ls', block)).toBe(`alias ls=ls\n\n${block}`);
		expect(withBlock('alias ls=ls\n', block)).toBe(`alias ls=ls\n\n${block}`);
		const replaced = withBlock(
			`before\n\n${block}after\n`,
			'# >>> npm-vm >>>\nexport X=2\n# <<< npm-vm <<<\n',
		);
		expect(replaced).toBe('before\n\n# >>> npm-vm >>>\nexport X=2\n# <<< npm-vm <<<\nafter\n');
		expect(withoutBlock(`alias ls=ls\n\n${block}`)).toBe('alias ls=ls\n');
		expect(withoutBlock(`before\n\n${block}after\n`)).toBe('before\n\nafter\n');
	});
});

describe('plan and apply', () => {
	it('is idempotent, backs up uniquely, and records the edit', () => {
		const root = makeTree({ home: {}, user: { '.zshrc': 'eval "$(fnm env)"\n' } });
		const dirs = dirsIn(root);
		const target = {
			shell: 'zsh' as const,
			file: join(root, 'user', '.zshrc'),
			parts: { path: false, hook: true },
		};
		const edit = planProfileEdit(target, join(root, 'home'));
		expect(edit?.diff).toContain('+# >>> npm-vm >>>');
		expect(edit?.diff).toContain('+_npm_vm_guard() {');
		const record = applyProfileEdit(dirs, owner, edit!);
		expect(readFileSync(target.file, 'utf8')).toBe(
			`eval "$(fnm env)"\n\n${profileBlock('zsh', join(root, 'home'), target.parts)}`,
		);
		expect(record.backup).not.toBeNull();
		expect(readFileSync(record.backup as string, 'utf8')).toBe('eval "$(fnm env)"\n');
		expect(readProfiles(dirs).entries).toHaveLength(1);
		expect(planProfileEdit(target, join(root, 'home'))).toBeNull();

		// A changed home rewrites the block in place with a second, distinct backup.
		const moved = planProfileEdit(target, join(root, 'home2'));
		const second = applyProfileEdit(dirs, owner, moved!);
		expect(second.backup).not.toBe(record.backup);
		expect(
			readdirSync(join(root, 'user')).filter((name) => name.includes('npm-vm-backup')),
		).toHaveLength(2);
		expect(readFileSync(target.file, 'utf8').match(/>>> npm-vm >>>/g)).toHaveLength(1);
		expect(readProfiles(dirs).entries).toHaveLength(1);
	});

	it('creates a missing file without a backup', () => {
		const root = makeTree({ home: {}, user: {} });
		const target = {
			shell: 'fish' as const,
			file: join(root, 'user', 'conf.d', 'npm-vm.fish'),
			parts: { path: true, hook: true },
		};
		const record = applyProfileEdit(
			dirsIn(root),
			owner,
			planProfileEdit(target, join(root, 'home'))!,
		);
		expect(record.backup).toBeNull();
		expect(existsSync(target.file)).toBe(true);
	});
});

describe('removeProfileBlock', () => {
	it('removes exactly the block when untouched, and refuses after a user edit', () => {
		const root = makeTree({ home: {}, user: { '.bashrc': 'export A=1\n' } });
		const dirs = dirsIn(root);
		const target = {
			shell: 'bash' as const,
			file: join(root, 'user', '.bashrc'),
			parts: { path: true, hook: true },
		};
		const record = applyProfileEdit(dirs, owner, planProfileEdit(target, join(root, 'home'))!);
		expect(removeProfileBlock(dirs, owner, record)).toBe('removed');
		expect(readFileSync(target.file, 'utf8')).toBe('export A=1\n');
		expect(readProfiles(dirs).entries).toEqual([]);

		const again = applyProfileEdit(dirs, owner, planProfileEdit(target, join(root, 'home'))!);
		writeFileSync(target.file, `${readFileSync(target.file, 'utf8')}export B=2\n`);
		expect(removeProfileBlock(dirs, owner, again)).toBe('changed');
		expect(readFileSync(target.file, 'utf8')).toContain('>>> npm-vm >>>');
		expect(readProfiles(dirs).entries).toHaveLength(1);
	});

	it('deletes a file that held only our block', () => {
		const root = makeTree({ home: {}, user: {} });
		const dirs = dirsIn(root);
		const target = {
			shell: 'fish' as const,
			file: join(root, 'user', 'npm-vm.fish'),
			parts: { path: true, hook: true },
		};
		const record = applyProfileEdit(dirs, owner, planProfileEdit(target, join(root, 'home'))!);
		expect(removeProfileBlock(dirs, owner, record)).toBe('removed');
		expect(existsSync(target.file)).toBe(false);
	});
});

describe.skipIf(process.platform === 'win32')('profileGuard', () => {
	it('refuses symlinks, unwritable files and chezmoi-managed files', () => {
		const root = makeTree({
			real: 'x',
			'ro.sh': 'x',
			'.local': { share: { chezmoi: { dot_zshrc: '' } } },
			'.zshrc': '',
		});
		symlinkSync(join(root, 'real'), join(root, 'link.sh'));
		expect(profileGuard(join(root, 'link.sh'), { HOME: root })).toMatch(/symlink/);
		chmodSync(join(root, 'ro.sh'), 0o444);
		if (process.getuid?.() !== 0) {
			expect(profileGuard(join(root, 'ro.sh'), { HOME: root })).toMatch(/not writable/);
		}
		expect(profileGuard(join(root, '.zshrc'), { HOME: root })).toMatch(/chezmoi/);
		expect(profileGuard(join(root, 'real'), { HOME: '/nonexistent' })).toBeNull();
		expect(profileGuard(join(root, 'new-file'), { HOME: '/nonexistent' })).toBeNull();
		expect(
			profileGuard(join(root, 'fish', 'conf.d', 'npm-vm.fish'), { HOME: '/nonexistent' }),
		).toBeNull();
	});
});
