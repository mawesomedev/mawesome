# Security

## What a project can and cannot do

A project controls one input: the version requirement in its `package.json`. With it, a project can select among genuine npm releases that support the active Node, or make the call fail with its `onFail` policy. It cannot:

- point npm-vm at a tarball: downloads always come from the registry the user's own npm config names;
- run code through npm-vm: nothing in the project is executed, the project `.npmrc` is never read, and `npm_config_*`, `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` from the environment never reach the download;
- change anything outside the cache: an `npm` call writes only cache entries, their leases and a private temp dir under the home, and finishes npm-vm's own interrupted journals.

A version string is validated before it reaches a command line, a URL or a message. Tags, URLs and overlong input are rejected.

## What is verified before an npm runs

1. **Registry signature.** `dist.signatures` over `npm@<version>:<integrity>` must verify against a key in the pinned keyring (the npm registry's published keys, shipped with npm-vm, append-only, with expiry and revocation). An unknown key id fails. A registry that signs nothing is accepted only when the project pins a tarball hash.
2. **Integrity.** The downloaded bytes must match the registry's sha512 and, when the project pins one, its `+sha512.`, `+sha256.` or `+sha224.` hash.
3. **Safe extraction.** Only regular files and directories under `package/` are extracted. Absolute paths, `..`, symlinks, hardlinks, devices and control characters abort the whole extraction. Modes are normalised to `0644` and `0755`; ownership and extended attributes are ignored; the archive is capped at 10,000 entries and 256 MiB.
4. **The extracted manifest.** `name` must be `npm`, `version` the resolved one, and `engines.node` is re-checked against the active Node. The packument's copy of `engines` is unsigned, so it only pre-filters.
5. **The cache entry.** Before use, an entry must carry a `.verified` marker for the expected integrity and be owned by the current user. An invalid entry is never used; a fresh copy is fetched beside it and `cache prune` removes it later.

Extra registry keys, for a private registry that signs with its own key, go in `<home>/state/keys.json`. Anything able to write there could replace the runtime itself, so this adds no trust the home does not already hold.

## Where the download goes

Node's own npm (8 or newer) is the transport. It runs in a private directory under the home, never the shared system temp dir, with the user and global config files named explicitly. The user's registry, proxy, CA and credentials apply exactly as they do for `npm install`; the project's do not. Credentials and client certificates go to the registry origin only.

## Helper processes

Node is always `process.execPath`. Every other helper (`ps`, `ioreg`, `reg.exe`, PowerShell, and the shells `doctor` asks) is spawned by absolute path with a sanitised environment, because inside an npm script `PATH` starts with `node_modules/.bin`, which any dependency can populate without running an install script. A shell is looked up through `$SHELL` or the system directories only. PowerShell always runs with `-NoProfile -NonInteractive`.

## Self-update

`self-update` verifies the registry signature of the new release and its SLSA provenance: the attestation is fetched from the registry origin only, its subject must name exactly `pkg:npm/%40mawesome/npm-vm@<version>` with the downloaded tarball's sha512, and the certificate must have been issued by `https://token.actions.githubusercontent.com` to `https://github.com/mawesomedev/mawesome/.github/workflows/release.yml@refs/heads/main`, checked through Sigstore's TUF-rooted trust. Versions only move forward; `--rollback` is offline. The first install through `npx` relies on the registry integrity check alone; every later version is provenance-verified. You can inspect a release's attestation with `npm view @mawesome/npm-vm dist.attestations`.

## Concurrency and crashes

Every command that writes outside the cache takes an exclusive lock created with `O_EXCL`. Nothing reclaims a lock: the next command names the file, says whether the owner still runs, and never judges a lock from another machine. Every file change goes through a journal with a backup and a staged copy, so the next command finishes or undoes an interrupted change and leaves a file someone else edited in the meantime alone. A running npm holds a lease on its cache entry, so a prune never removes one in use.

## Windows file ACLs

Edits go through a temp file renamed into place, so an edited profile or `package.json` takes its directory's ACL rather than keeping a custom one set on the file itself. POSIX modes are preserved.

## Directories

The home, state and cache directories are created with mode `0700`. On POSIX, a home or cache owned by someone else or writable by other users is refused. Secrets are never printed: messages show proxy and registry URLs with their user info replaced.

## No telemetry

npm-vm sends nothing anywhere. Its only network peers are the configured registry (through the user's proxy) and, during `self-update`, Sigstore's TUF and transparency-log endpoints.
