#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv.slice(2));
process.exitCode = code;
// Backstop: a handle left open by a library must not keep a finished scan alive.
setTimeout(() => process.exit(code), 2_000).unref();
