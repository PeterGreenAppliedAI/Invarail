#!/usr/bin/env node
// Entry point only: the logic (and its tests) live in supervisor-lib.mjs, which carries no
// shebang — a shebang in an imported module tripped Vite's transform on Windows CI.
import { main } from './supervisor-lib.mjs';
main();
