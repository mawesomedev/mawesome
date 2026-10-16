/* @npmcli/config ships no types; only the surface npm-vm uses is declared. */
declare module '@npmcli/config' {
	interface ConfigOptions {
		definitions: unknown;
		shorthands: unknown;
		flatten: unknown;
		nerfDarts: readonly string[];
		npmPath: string;
		env: NodeJS.ProcessEnv;
		argv: readonly string[];
		platform?: NodeJS.Platform;
		execPath?: string;
		cwd: string;
		excludeNpmCwd?: boolean;
	}
	interface Credentials {
		token?: string;
		username?: string;
		password?: string;
		certfile?: string;
		keyfile?: string;
		auth?: string;
	}
	export default class Config {
		constructor(options: ConfigOptions);
		load(): Promise<void>;
		get(key: string): unknown;
		getCredentialsByURI(uri: string): Credentials;
		readonly localPrefix: string;
		readonly globalPrefix: string;
	}
}

declare module '@npmcli/config/lib/definitions/index.js' {
	const npmDefinitions: {
		definitions: unknown;
		shorthands: unknown;
		flatten: unknown;
		nerfDarts: readonly string[];
	};
	export default npmDefinitions;
}
