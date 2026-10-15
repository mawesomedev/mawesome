import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A file tree spec: a string is file content, an object is a directory. */
export interface Tree {
	[name: string]: string | Tree;
}

const created: string[] = [];

/** Writes `tree` under a fresh temp dir and returns its real path (macOS symlinks `/tmp`). */
export function makeTree(tree: Tree, prefix = 'npm-use-'): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	created.push(root);
	writeTree(root, tree);
	return root;
}

export function writeTree(root: string, tree: Tree): void {
	for (const [name, value] of Object.entries(tree)) {
		const target = join(root, name);
		if (typeof value === 'string') {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, value);
		} else {
			mkdirSync(target, { recursive: true });
			writeTree(target, value);
		}
	}
}

export function removeTrees(): void {
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function manifest(fields: Record<string, unknown> = {}): string {
	return JSON.stringify({ name: 'fixture', version: '0.0.0', ...fields });
}
