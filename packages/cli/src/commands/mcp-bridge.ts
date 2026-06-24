/**
 * `agentproto mcp-bridge` — stdio MCP server that proxies to the
 * daemon's HTTP `/mcp` orchestration endpoint.
 *
 * Stdio-only MCP clients (Codex, Cursor, Claude Desktop, Hermes) can
 * use agentproto's orchestration tools uniformly through this bridge
 * — no third-party bridge needed.
 *
 * Usage:
 *   agentproto mcp-bridge
 *
 * Configuration:
 *   AGENTPROTO_MCP_URL  — explicit URL (e.g. http://127.0.0.1:18790/mcp)
 *   ~/.agentproto/config.json → daemon.port (default 18790)
 *
 * Register in a stdio MCP client:
 *   {
 *     "agentproto": {
 *       "command": "agentproto",
 *       "args": ["mcp-bridge"],
 *       "env": { "AGENTPROTO_MCP_URL": "http://127.0.0.1:18790/mcp" }
 *     }
 *   }
 *
 * Port gotcha: if daemon.port is not 18790, set AGENTPROTO_MCP_URL
 * to match, else the bridge connects to the wrong port silently.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "@agentproto/runtime/config"

export async function runMcpBridge(_args: readonly string[]): Promise<number> {
  const url = process.env.AGENTPROTO_MCP_URL ?? (await resolveDefaultUrl())

  if (!process.env.AGENTPROTO_MCP_URL) {
    process.stderr.write(
      `agentproto mcp-bridge: AGENTPROTO_MCP_URL not set, using ${url}\n`
    )
  }

  const client = new Client(
    { name: "agentproto-mcp-bridge", version: "0.1.0" },
    { capabilities: {} }
  )

  try {
    const httpTransport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(httpTransport)
  } catch (err) {
    process.stderr.write(
      `agentproto mcp-bridge: failed to connect to daemon at ${url} — ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `  Is the daemon running? Start it: agentproto serve\n`
    )
    return 1
  }

  // Probe the tool list once so we can report the count on startup.
  let toolCount = 0
  try {
    const { tools } = await client.listTools()
    toolCount = tools.length
  } catch (err) {
    process.stderr.write(
      `agentproto mcp-bridge: connected but listTools failed — ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }

  const server = new Server(
    { name: "agentproto-mcp-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } }
  )

  // Pass-through: forward the daemon's tool list with original JSON schemas
  // intact so stdio clients see the real parameter names and types.
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())

  // Pass-through: forward call-tool requests verbatim to the daemon.
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    client.callTool(req.params)
  )

  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)

  process.stderr.write(
    `agentproto mcp-bridge: connected to ${url}, ` +
      `proxying ${toolCount} tool(s) over stdio\n`
  )

  // Park forever — StdioServerTransport stays alive until stdin closes
  // or the process is killed.
  await new Promise<never>(() => {})
  // Unreachable — satisfies TS strict return check (Promise<never> never resolves).
  return 0
}

async function resolveDefaultUrl(): Promise<string> {
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  return `http://127.0.0.1:${port}/mcp`
}
