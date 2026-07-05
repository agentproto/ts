/**
 * MCP tools that expose the eval-reporter adapter family to agents connected
 * to the daemon. Lets a remote operator list eval reporters and configure
 * Langfuse credentials without touching the terminal.
 *
 * Two tools:
 *   list_eval_reporters   browse known eval reporter backends
 *   setup_eval_reporter   configure Langfuse credentials
 *
 * Rides on @agentproto/eval-reporters; credentials live 0600 under
 * ~/.agentproto and are never exposed by the list tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeEvalReporterTools } from "@agentproto/eval-reporters"

/** Register list_eval_reporters + setup_eval_reporter on the daemon MCP server.
 *  Rides on @agentproto/eval-reporters (adapter-kit family); creds live 0600 under
 *  ~/.agentproto, never exposed by the list tool. */
export function registerEvalReporterTools(server: McpServer): void {
  const tools = makeEvalReporterTools()

  server.tool(
    tools.list_eval_reporters.name,
    tools.list_eval_reporters.description,
    async () => {
      const r = await tools.list_eval_reporters.handler()
      return { content: [...r.content], ...(r.isError ? { isError: true } : {}) }
    },
  )

  server.tool(
    tools.setup_eval_reporter.name,
    tools.setup_eval_reporter.description,
    tools.setup_eval_reporter.inputSchema.shape,
    async (args) => {
      const r = await tools.setup_eval_reporter.handler(args)
      return { content: [...r.content], ...(r.isError ? { isError: true } : {}) }
    },
  )
}
