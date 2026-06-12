#!/usr/bin/env node
// Thin launcher — the built CLI runs on import. Kept separate so the shebang
// lives on a checked-in file rather than fighting the bundler's per-entry output.
import "../dist/cli.mjs"
