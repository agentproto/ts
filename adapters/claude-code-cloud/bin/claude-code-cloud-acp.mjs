#!/usr/bin/env node
// Thin launcher — invokes the built ACP server's exported `main`. Kept
// separate so the shebang lives on a checked-in file rather than fighting
// the bundler's per-entry output (same pattern as packages/secrets).
// `main` is exported (not run at import time) so tests can import
// acp-server.ts's helpers without booting a real stdio server.
import { main } from "../dist/acp-server.mjs"

main()
