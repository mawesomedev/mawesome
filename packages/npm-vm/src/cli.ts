#!/usr/bin/env node
import { run } from './commands/dispatch.ts';

process.exitCode = await run(process.argv.slice(2), {});
