#!/usr/bin/env node
/**
 * `npx interfacer <project-name> [--root <dir>] [--entry-point ...]`
 *
 * Phase 9 gives this real argument parsing, location resolution, and the
 * credential preflight that checks `API_KEY` before a browser opens or the first
 * interview question is asked. Phase 0 only proves the `bin` entry point builds,
 * is executable, and is wired to the package.
 */
import { packageName } from './index.js';

process.stdout.write(`${packageName}: not implemented yet (scaffolding, phase 0)\n`);
process.exitCode = 1;
