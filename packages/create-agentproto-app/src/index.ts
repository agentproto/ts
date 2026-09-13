/**
 * `create-agentproto-app <dir>` — scaffold an agentproto agent app: the
 * `.agentproto/` shell (APP.md, one agent, one workflow) plus a Vite +
 * TanStack Router + TanStack Query `ui/` project that builds to static
 * files in `.agentproto/ui/`. See `./cli.ts` for the verb; this module is
 * the bin entry point (`pnpm create agentproto-app <dir>`).
 */

import { runCreateApp } from "./cli.js"

runCreateApp(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`create-agentproto-app: ${msg}\n`)
    process.exitCode = 1
  },
)
