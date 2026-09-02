/**
 * `agentproto mcp-app <appId>` — stdio MCP server scoped to ONE installed
 * app's tools, for distributing an app (e.g. a book bundle) to buyers'
 * Codex/Cursor/Windsurf MCP clients without exposing the full daemon `/mcp`
 * gateway (~100 tools including `command_execute`, fs, `agent_*`).
 *
 * v1 is a thin proxy, reusing existing daemon primitives rather than
 * building new dispatch logic:
 *   - `findInstalledAppDir` / `readDeclaredUITools` (../app-serve.js) read
 *     the app's `ui.tools` allowlist straight off its installed APP.md.
 *   - One MCP tool is registered per allowlisted name (verbatim), each
 *     forwarding a generic `{ args }` payload to the daemon's
 *     `POST /apps/:appId/tool-call` route — the same allowlist+dispatch
 *     chokepoint (`performAppToolCall`) the browser bridge (`app serve`)
 *     and the `app_tool_call` MCP verb already share, so this surface
 *     can't drift from either and re-enforces the allowlist server-side
 *     even if this file's own filtering ever had a bug.
 *
 * Registering the tool list needs no running daemon (it only reads APP.md
 * off disk); only an actual tool CALL needs `agentproto serve` up, and
 * returns a clear error result rather than crashing when it isn't.
 *
 * Usage:
 *   agentproto mcp-app <appId>
 *
 * Configuration:
 *   AGENTPROTO_DAEMON_URL  — daemon base URL override (e.g.
 *                            http://127.0.0.1:18790), same env var
 *                            `_daemon-helpers.ts` reads elsewhere in the CLI
 *   ~/.agentproto/config.json → daemon.port (default 18790)
 *
 * Register in a stdio MCP client:
 *   {
 *     "mcpServers": {
 *       "<appId>": { "command": "agentproto", "args": ["mcp-app", "<appId>"] }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { loadConfig } from "@agentproto/runtime/config"
import { findInstalledAppDir, readDeclaredUITools } from "../app-serve.js"

const USAGE = `agentproto mcp-app <appId> — stdio MCP server scoped to one installed app

Usage:
  agentproto mcp-app <appId>

Registers one MCP tool per the app's declared \`ui.tools\` allowlist
(APP.md frontmatter), each forwarding to the daemon's
POST /apps/:appId/tool-call route. The app must already be installed
(\`agentproto app install <dir>\`) and declare a \`ui.tools\` allowlist —
mcp-app refuses to serve an app with no declared allowlist rather than
falling back to exposing every daemon tool.

The daemon (\`agentproto serve\`) does not need to be running to start this
process — only to actually dispatch a tool call.
`

export async function runMcpApp(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const appId = args[0]
  if (!appId) {
    process.stderr.write(USAGE)
    return 2
  }

  const appDir = findInstalledAppDir(appId)
  if (!appDir) {
    process.stderr.write(
      `agentproto mcp-app: no installed app "${appId}" — run \`agentproto app install <dir>\` first.\n`,
    )
    return 1
  }

  const tools = await readDeclaredUITools(appDir)
  if (tools === undefined) {
    process.stderr.write(
      `agentproto mcp-app: app "${appId}" has no \`ui.tools\` allowlist declared in APP.md — ` +
        "mcp-app requires an explicit allowlist to scope what a buyer's MCP client can see. " +
        "Add `ui: { tools: [...] }` to APP.md.\n",
    )
    return 1
  }

  const toolCallUrl = `${await resolveDaemonBaseUrl()}/apps/${encodeURIComponent(appId)}/tool-call`

  const server = new McpServer({ name: `agentproto-mcp-app-${appId}`, version: "0.1.0" })

  for (const toolName of tools) {
    server.tool(
      toolName,
      `Scoped proxy for installed app "${appId}"'s "${toolName}" tool (see the app's ui.tools allowlist).`,
      { args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the underlying tool.") },
      async (input) => callScopedTool(toolCallUrl, toolName, input.args ?? {}),
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(
    `agentproto mcp-app: serving ${tools.length} tool(s) for app "${appId}" (dispatching to ${toolCallUrl})\n`,
  )

  // Park forever — StdioServerTransport stays alive until stdin closes or
  // the process is killed (mirrors mcp-bridge.ts).
  await new Promise<never>(() => {})
  // Unreachable — satisfies TS strict return check (Promise<never> never resolves).
  return 0
}

async function resolveDaemonBaseUrl(): Promise<string> {
  const override = process.env.AGENTPROTO_DAEMON_URL
  if (override) return override.replace(/\/+$/, "")
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  return `http://127.0.0.1:${port}`
}

interface CallToolResult {
  content: { type: "text"; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

/**
 * Forward one scoped tool call to `POST /apps/:appId/tool-call`. That
 * route (`performAppToolCall` under the hood) always answers 200 with an
 * MCP `CallToolResult` envelope for a well-formed body — allowlist
 * rejections and dispatch failures come back as `isError: true` results,
 * not HTTP error statuses — so the only HTTP-level failure this needs to
 * handle itself is the daemon being unreachable.
 */
export async function callScopedTool(
  url: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    })
  } catch (err) {
    return errorResult(
      `could not reach the daemon at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Start it: agentproto serve",
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return errorResult(`daemon returned a non-JSON response (HTTP ${response.status}) from ${url}.`)
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in (body as object)
        ? String((body as { message: unknown }).message)
        : `HTTP ${response.status}`
    return errorResult(message)
  }

  if (body && typeof body === "object" && Array.isArray((body as { content?: unknown }).content)) {
    return body as CallToolResult
  }
  return { content: [{ type: "text", text: JSON.stringify(body) }] }
}
