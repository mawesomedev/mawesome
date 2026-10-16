'use strict';
/*
 * npm-vm launcher entry (spec RUN-2), called by the shims as `node bootstrap.cjs <npm|npx|cli> [arguments]`.
 * Hand-written ES5 so any Node from 10 up can run it and fall back to Node's own npm below the floor.
 */
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var LAUNCHER_ABI = 1;
var FLOOR = [22, 9, 0];
var FLOOR_TEXT = '22.9.0';
var VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
var home = __dirname;

function fail(message, code) {
	process.stderr.write('npm-vm: ' + message + '\n');
	process.exitCode = code;
}

function setupHint() {
	return 'Run "npx --prefix ~ -y @mawesome/npm-vm setup" to reinstall npm-vm.';
}

function belowFloor(version) {
	var parts = version.split('.');
	for (var i = 0; i < 3; i += 1) {
		var part = parseInt(parts[i], 10) || 0;
		if (part < FLOOR[i]) {
			return true;
		}
		if (part > FLOOR[i]) {
			return false;
		}
	}
	return false;
}

function ownNpmRoot() {
	if (process.platform === 'win32') {
		return path.join(path.dirname(process.execPath), 'node_modules', 'npm');
	}
	var real = process.execPath;
	try {
		real = fs.realpathSync(process.execPath);
	} catch (error) {
		// Resolve as given; a missing npm is reported when spawning fails.
	}
	return path.join(path.dirname(real), '..', 'lib', 'node_modules', 'npm');
}

function declaresNpm(manifest) {
	var devEngines = manifest && manifest.devEngines;
	var pm = devEngines && devEngines.packageManager;
	if (pm) {
		var entries = Array.isArray(pm) ? pm : [pm];
		for (var i = 0; i < entries.length; i += 1) {
			if (entries[i] && entries[i].name === 'npm') {
				return true;
			}
		}
	}
	return (
		typeof manifest.packageManager === 'string' && manifest.packageManager.indexOf('npm@') === 0
	);
}

/** Whether the nearest package.json above cwd asks for an npm version, so the fallback can say it is ignored. */
function projectDeclaresNpm() {
	var dir = process.cwd();
	for (;;) {
		var file = path.join(dir, 'package.json');
		if (fs.existsSync(file)) {
			try {
				return declaresNpm(JSON.parse(fs.readFileSync(file, 'utf8')));
			} catch (error) {
				return false;
			}
		}
		var parent = path.dirname(dir);
		if (parent === dir) {
			return false;
		}
		dir = parent;
	}
}

/** Runs a Node script with the inherited stdio, forwarding signals as the runtime does (spec RUN-4, RUN-5). */
function runScript(script, args) {
	var child = childProcess.spawn(process.execPath, [script].concat(args), { stdio: 'inherit' });
	var handlers = [];
	var alive = true;
	function forward(signal) {
		if (alive) {
			child.kill(signal);
		}
	}
	function later(signal) {
		var timer = setTimeout(function () {
			forward(signal);
		}, 1000);
		if (timer.unref) {
			timer.unref();
		}
	}
	if (process.platform !== 'win32') {
		var now = ['SIGTERM', 'SIGHUP'];
		var delayed = ['SIGINT', 'SIGQUIT'];
		var i;
		for (i = 0; i < now.length; i += 1) {
			handlers.push([now[i], forward.bind(null, now[i])]);
		}
		for (i = 0; i < delayed.length; i += 1) {
			handlers.push([delayed[i], later.bind(null, delayed[i])]);
		}
		for (i = 0; i < handlers.length; i += 1) {
			process.on(handlers[i][0], handlers[i][1]);
		}
	}
	function cleanup() {
		alive = false;
		for (var j = 0; j < handlers.length; j += 1) {
			process.removeListener(handlers[j][0], handlers[j][1]);
		}
	}
	child.on('error', function (error) {
		cleanup();
		fail('cannot start ' + script + ': ' + error.message, 1);
	});
	child.on('exit', function (code, signal) {
		cleanup();
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exitCode = code === null ? 1 : code;
	});
}

function runOwnNpm(selector, args) {
	if (projectDeclaresNpm()) {
		process.stderr.write(
			'npm-vm: Node ' +
				process.versions.node +
				' is below ' +
				FLOOR_TEXT +
				"; running Node's own npm and ignoring the project's npm requirement. Upgrade Node to honour it.\n"
		);
	}
	var cli = selector === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
	runScript(path.join(ownNpmRoot(), 'bin', cli), args);
}

function runtimePath(candidate) {
	if (candidate) {
		return path.join(__dirname, 'runtime.cjs');
	}
	var current;
	try {
		current = fs.readFileSync(path.join(home, 'current'), 'utf8').trim();
	} catch (error) {
		return null;
	}
	if (!VERSION_RE.test(current)) {
		return null;
	}
	var installed = path.join(home, 'versions', current, 'runtime.cjs');
	if (fs.existsSync(installed)) {
		return installed;
	}
	return replacedRuntime(current);
}

/** A reinstall of the current version moves the old copy aside for an instant; a crash there leaves it usable. */
function replacedRuntime(version) {
	var versions = path.join(home, 'versions');
	var names;
	try {
		names = fs.readdirSync(versions);
	} catch (error) {
		return null;
	}
	var prefix = '.' + version + '.replaced.';
	for (var i = 0; i < names.length; i += 1) {
		if (
			names[i].indexOf(prefix) === 0 &&
			fs.existsSync(path.join(versions, names[i], 'runtime.cjs'))
		) {
			return path.join(versions, names[i], 'runtime.cjs');
		}
	}
	return null;
}

function main() {
	var args = process.argv.slice(2);
	var candidate = false;
	if (args[0] === '--candidate') {
		candidate = true;
		args.shift();
	}
	var selector = args.shift();
	if (selector !== 'npm' && selector !== 'npx' && selector !== 'cli') {
		fail('usage: bootstrap.cjs <npm|npx|cli> [arguments]', 64);
		return;
	}
	if (belowFloor(process.versions.node)) {
		if (selector === 'cli') {
			fail(
				'npm-vm needs Node ' +
					FLOOR_TEXT +
					' or newer; the active Node is ' +
					process.versions.node +
					'. ' +
					setupHint(),
				64
			);
			return;
		}
		runOwnNpm(selector, args);
		return;
	}
	var script = runtimePath(candidate);
	if (script === null) {
		fail(
			'launcher mismatch: the current pointer in ' +
				home +
				' is missing or malformed. ' +
				setupHint(),
			6
		);
		return;
	}
	var runtime;
	try {
		runtime = require(script);
	} catch (error) {
		fail(
			'launcher mismatch: cannot load ' + script + ' (' + error.message + '). ' + setupHint(),
			6
		);
		return;
	}
	if (
		typeof runtime.abi !== 'number' ||
		runtime.abi > LAUNCHER_ABI ||
		runtime.abi < LAUNCHER_ABI - 1
	) {
		fail(
			'launcher mismatch: runtime ABI ' +
				runtime.abi +
				' is not supported by launcher ABI ' +
				LAUNCHER_ABI +
				'. ' +
				setupHint(),
			6
		);
		return;
	}
	runtime.main(selector, args, { home: home, launcherAbi: LAUNCHER_ABI }).then(
		function (code) {
			process.exitCode = code;
			return code;
		},
		function (error) {
			fail(error && error.stack ? error.stack : String(error), 1);
			return 1;
		}
	);
}

main();
