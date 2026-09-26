/**
 * The MCP Apps host verbs — `mcp_app_ui_index`, `mcp_app_ui_read`,
 * `mcp_app_tool_call` — over `McpAppsHostService` (mcp-apps-host.ts).
 * MCP tools only, no HTTP route: session-chat reaches the daemon through
 * tool calls on its APP.md `ui.tools` allowlist.
 *
 * Every verb answers with its contract shape as JSON text (what
 * session-chat's `callAgentprotoToolJson` unwraps), and never sets the
 * MCP-level `isError`: failures are in-band (`status` / `error`, or the
 * `isError` of the returned `CallToolResult`).
 *
 * Gating: registered on the same root `/mcp` surface as
 * `mcp_imported_call` and, like it, NOT on the scoped orchestrator
 * gateway (orchestrator-gateway.ts `DEFAULT_ORCHESTRATOR_TOOLS`).
 * `mcp_imported_call` has no per-call permission check of its own, so
 * neither does `mcp_app_tool_call` beyond the allowlist below.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { McpAppsHostService } from "./mcp-apps-host.js"

export interface RegisterMcpAppHostToolsOptions {
  service: McpAppsHostService
}

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

export function registerMcpAppHostTools(
  server: McpServer,
  opts: RegisterMcpAppHostToolsOptions
): void {
  const { service } = opts

  server.tool(
    "mcp_app_ui_index",
    "MCP Apps host: which tools of one MCP server (as a session's harness " +
      "names it, e.g. `guilde` in `mcp__guilde__…`) declare a UI " +
      "(`_meta.ui.resourceUri`), plus every app-only tool. The server is " +
      "resolved in the session's scope (session config → project → user → " +
      "imports). Returns `{ server, status, tools, appOnlyTools, error?, " +
      "source? }`; status is ok | unresolved | unreachable | auth_required. " +
      "Cached; failures are retried at most once a minute.",
    {
      sessionId: z.string().min(1).describe("Session whose transcript mentions the server."),
      server: z.string().min(1).describe("Server alias as the harness names it."),
    },
    async input => json(await service.uiIndex(input.sessionId, input.server))
  )

  server.tool(
    "mcp_app_ui_read",
    "MCP Apps host: read one `ui://` resource of a server — its HTML and " +
      "`_meta.ui` (csp, permissions, prefersBorder, domain). `resourceUri` " +
      "must be one `mcp_app_ui_index` returned for that server; anything " +
      "else is refused. Returns `{ resourceUri, html, mimeType, csp?, " +
      "permissions?, prefersBorder?, domain? }` or `{ error, status }`.",
    {
      sessionId: z.string().min(1),
      server: z.string().min(1),
      resourceUri: z.string().min(1).describe("A `ui://…` uri from mcp_app_ui_index."),
    },
    async input => json(await service.readUi(input.sessionId, input.server, input.resourceUri))
  )

  server.tool(
    "mcp_app_tool_call",
    "MCP Apps host: a `tools/call` made by an app UI iframe (not by the " +
      "model). `tool` must be one of the server's UI tools, its app-only " +
      "tools, or the tool whose transcript card hosts the iframe; anything " +
      "else is refused. The call is recorded on the session as " +
      "`kind: \"mcp_app_tool_call\"`. Returns the upstream `CallToolResult` " +
      "verbatim, or `{ isError: true, content: [{ type: \"text\", text }] }`.",
    {
      sessionId: z.string().min(1),
      server: z.string().min(1),
      tool: z.string().min(1).describe("Upstream tool name (not namespaced)."),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments. Default {}."),
      originToolCallId: z
        .string()
        .min(1)
        .describe("Transcript tool_use id of the card hosting the iframe."),
    },
    async input =>
      json(
        await service.callTool({
          sessionId: input.sessionId,
          server: input.server,
          tool: input.tool,
          originToolCallId: input.originToolCallId,
          ...(input.args ? { args: input.args } : {}),
        })
      )
  )
}
