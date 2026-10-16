/*
 * Internals the GitHub Action shares with the package. Not public API: anything here may change in any release.
 * The package root (`index.ts`) stays limited to `resolveNpm` and its types (spec section 3.1).
 */
export { resolveNpmWith } from './index.ts';
export type { ResolveOptions, ResolveProviders, ResolveResult, ResolveSource } from './index.ts';
export { createContext, createInstaller } from './install/index.ts';
export type { EnsureOptions, InstallContext, Installer, PackedSource } from './install/index.ts';
export { run as runCommand } from './commands/dispatch.ts';
export type { CommandIo } from './commands/context.ts';
export type { DispatchOptions } from './commands/dispatch.ts';
export { selectCandidate, sriHex } from './select.ts';
export type { Candidate, Selection } from './select.ts';
export { parseSpecs, parseVersionSpec, SpecError } from './spec.ts';
export type { NpmSpec, OnFail, ParsedSpecs } from './spec.ts';
export { findProject } from './project.ts';
export { EXIT, isNpmVmError, NpmVmError } from './errors.ts';
