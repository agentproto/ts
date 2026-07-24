#!/usr/bin/env node
/**
 * `agentproto-code-brain-gbrain` — the standalone `ask_codebase` MCP server
 * binary. Boots {@link startAskCodebaseHttpServer} backed by a gbrain
 * provider (local docker exec by default, HTTP when `CODE_BRAIN_MCP_BACKEND=http`)
 * on `127.0.0.1:8831 /mcp`. This is the tracked launcher PR-5 repoints the
 * `code-explorer` alias to.
 */

import { gbrainLocalProvider } from "./gbrain-local.js"
import { gbrainHttpProvider } from "./gbrain-http.js"
import { loadCodeBrainMcpServerEnv } from "./env.js"
import { startAskCodebaseHttpServer } from "./mcp-server.js"
import type { ICodeBrainProvider } from "@agentproto/code-brain"

async function main(): Promise<void> {
  const env = loadCodeBrainMcpServerEnv()
  const provider: ICodeBrainProvider =
    env.backend === "http" ? gbrainHttpProvider() : gbrainLocalProvider()

  const server = await startAskCodebaseHttpServer({
    provider,
    host: env.host,
    port: env.port,
  })
  process.stderr.write(
    `code-brain-gbrain: ask_codebase MCP (${env.backend}) on http://${server.host}:${server.port}/mcp\n`,
  )

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((error) => {
  process.stderr.write(`code-brain-gbrain: fatal: ${String(error)}\n`)
  process.exit(1)
})
