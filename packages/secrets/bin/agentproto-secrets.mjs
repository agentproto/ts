#!/usr/bin/env node
// Thin launcher — invokes the built CLI's exported `main`. Kept separate so
// the shebang lives on a checked-in file rather than fighting the bundler's
// per-entry output. `main` is exported (not run at import time) so tests can
// import `cli.ts`'s helpers without triggering a real CLI invocation.
import { main } from "../dist/cli.mjs"

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    process.stderr.write(
      `agentproto-secrets: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exitCode = 1
  })
