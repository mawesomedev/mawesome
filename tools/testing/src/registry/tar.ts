import { gzipSync } from 'node:zlib';

/** A tar entry written byte by byte, so tests can produce what no packer would: `..`, symlinks, setuid bits. */
export interface TarEntry {
	path: string;
	/** ustar type flag: `0` file, `5` directory, `2` symlink, `1` hardlink, `3` character device. */
	type?: '0' | '1' | '2' | '3' | '5';
	content?: string | Buffer;
	mode?: number;
	linkpath?: string;
}

function field(buffer: Buffer, offset: number, length: number, value: string): void {
	buffer.write(value, offset, length, 'utf8');
}

function octal(buffer: Buffer, offset: number, length: number, value: number): void {
	field(buffer, offset, length, value.toString(8).padStart(length - 1, '0'));
}

function header(entry: TarEntry, size: number): Buffer {
	const block = Buffer.alloc(512);
	const type = entry.type ?? '0';
	field(block, 0, 100, entry.path);
	octal(block, 100, 8, entry.mode ?? (type === '5' ? 0o755 : 0o644));
	octal(block, 108, 8, 0);
	octal(block, 116, 8, 0);
	octal(block, 124, 12, size);
	octal(block, 136, 12, 0);
	field(block, 148, 8, '        ');
	field(block, 156, 1, type);
	field(block, 157, 100, entry.linkpath ?? '');
	field(block, 257, 6, 'ustar');
	field(block, 263, 2, '00');
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return block;
}

/** A gzipped ustar archive of `entries`, in order. */
export function buildTarball(entries: readonly TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const type = entry.type ?? '0';
		const content = type === '0' ? Buffer.from(entry.content ?? '') : Buffer.alloc(0);
		blocks.push(header(entry, content.length));
		if (content.length > 0) {
			const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
			content.copy(padded);
			blocks.push(padded);
		}
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

/** The entries of a minimal npm package: a manifest and the two CLI entry points, which print the version. */
export function npmPackageEntries(
	version: string,
	options: { engines?: string; name?: string; extra?: TarEntry[] } = {},
): TarEntry[] {
	const manifest: Record<string, unknown> = { name: options.name ?? 'npm', version };
	if (options.engines !== undefined) {
		manifest['engines'] = { node: options.engines };
	}
	/*
	 * The stand-in CLI prints its version and args, exits with `--exit <n>`, prints argv[1] with `--argv1`,
	 * and with `--sleep` reports each signal it receives so launcher tests can watch forwarding.
	 */
	const cli = [
		'#!/usr/bin/env node',
		'const args = process.argv.slice(2);',
		"const exitAt = args.indexOf('--exit');",
		'if (exitAt !== -1) process.exit(Number(args[exitAt + 1]));',
		"if (args.includes('--argv1')) { console.log(process.argv[1]); process.exit(0); }",
		"console.log(require('../package.json').version + ' ' + args.join(' '));",
		"if (args.includes('--sleep')) {",
		"  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {",
		"    process.on(signal, () => { console.log('got ' + signal); setTimeout(() => process.kill(process.pid, signal), 50); process.removeAllListeners(signal); });",
		'  }',
		"  console.log('sleeping');",
		'  setInterval(() => {}, 1000);',
		'}',
		'',
	].join('\n');
	return [
		{ path: 'package/', type: '5' },
		{ path: 'package/package.json', content: JSON.stringify(manifest) },
		{ path: 'package/bin/', type: '5' },
		{ path: 'package/bin/npm-cli.js', content: cli, mode: 0o755 },
		{ path: 'package/bin/npx-cli.js', content: cli, mode: 0o755 },
		...(options.extra ?? []),
	];
}
