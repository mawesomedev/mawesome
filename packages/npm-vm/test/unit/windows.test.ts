import { describe, expect, it } from 'vitest';
import { autoRunCommand, withoutAutoRunCommand } from '../../src/setup/windows.ts';

describe('cmd AutoRun', () => {
	it('strips exactly the generated fragment and keeps the user commands', () => {
		const ours = autoRunCommand('C:\\tools\\vm\\shims');
		expect(withoutAutoRunCommand(null)).toBe('');
		expect(withoutAutoRunCommand(ours)).toBe('');
		expect(withoutAutoRunCommand(`${ours} & doskey ls=dir`)).toBe('doskey ls=dir');
		// A home without "npm-vm" in its path: the set half carries no marker, it still goes.
		expect(withoutAutoRunCommand(`${autoRunCommand('C:\\x\\shims')} & cls`)).toBe('cls');
		// Someone else's AutoRun mentioning npm-vm is not ours.
		expect(withoutAutoRunCommand('echo npm-vm')).toBe('echo npm-vm');
	});

	it('a repeated setup rebuilds the value without losing the user commands', () => {
		const first = `${autoRunCommand('C:\\a\\shims')} & doskey ls=dir`;
		const kept = withoutAutoRunCommand(first);
		expect(`${autoRunCommand('C:\\b\\shims')} & ${kept}`).toBe(
			'set "PATH=C:\\b\\shims;%PATH%" & rem npm-vm & doskey ls=dir',
		);
	});
});
