/**
 * `agentproto mcp-bridge` — stdio MCP server that proxies to the
 * daemon's HTTP `/mcp` orchestration endpoint.
 *
 * Stdio-only MCP clients (Codex, Cursor, Claude Desktop, Hermes) can
 * use agentproto's orchestration tools uniformly through this bridge
 * — no third-party bridge needed.
 *
 * Usage:
 *   agentproto mcp-bridge [--surface approval-cards]
 *
 * `--surface <name>` sets `?surface=<name>` on the daemon URL (the default
 * one or AGENTPROTO_MCP_URL; any other query parameter in it is kept). Only
 * `approval-cards` is accepted: the human-facing Approve / Refuse cards for
 * Claude Desktop, see `install-mcp --approvals`.
 *
 * Configuration:
 *   AGENTPROTO_MCP_URL  - explicit URL (e.g. http://127.0.0.1:18790/mcp);
 *                         its query string is passed to the daemon as is
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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "@agentproto/runtime/config"
import {
  claudeSessionHeaders,
  exitOnStdinClose,
  parseBridgeArgs,
  readClaudeSessionId,
  redactSessionId,
  stampOrigin,
  watchParentExit,
  withSurface,
} from "./mcp-bridge.logic.js"

export async function runMcpBridge(args: readonly string[]): Promise<number> {
  const parsed = parseBridgeArgs(args)
  if ("error" in parsed) {
    process.stderr.write(`agentproto mcp-bridge: ${parsed.error}\n`)
    return 2
  }
  const baseUrl = process.env.AGENTPROTO_MCP_URL ?? (await resolveDefaultUrl())
  const url = parsed.surface ? withSurface(baseUrl, parsed.surface) : baseUrl

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
    // Under Claude Code the bridge inherits CLAUDE_CODE_SESSION_ID: attest it
    // on every request so the daemon can attribute the call to the real
    // `cc:<id>` row. A header, not the URL, so the mount URL stays stable.
    const sessionHeaders = claudeSessionHeaders(process.env)
    const attested = readClaudeSessionId(process.env)
    if (attested) {
      process.stderr.write(
        `agentproto mcp-bridge: attesting Claude Code session ${redactSessionId(attested)}\n`
      )
    }
    const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: sessionHeaders },
    })
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

  // Resources must be forwarded too: MCP Apps hosts (Claude Desktop/Cowork)
  // resolve a tool's `_meta.ui.resourceUri` via `resources/read`. A bridge
  // that only forwards tools answers -32601 there and the host renders
  // "cannot reach <server>" even though every tool call succeeds.
  const server = new Server(
    { name: "agentproto-mcp-bridge", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  )

  // Pass-through: forward the daemon's tool list with original JSON schemas
  // intact so stdio clients see the real parameter names and types.
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())

  // Pass-through: forward call-tool requests verbatim to the daemon.
  // Auto-stamp origin: the host announced itself in initialize
  // (clientInfo.name); ride it onto any spawn we forward so a bridge-routed
  // host gets a source node in the tree (#575). Never overrides an explicit
  // origin; only session-creating tools (mcp-bridge.logic.ts).
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    client.callTool(stampOrigin(req.params, server.getClientVersion()?.name))
  )

  // Pass-through: resources (ui:// panels for MCP Apps hosts).
  server.setRequestHandler(ListResourcesRequestSchema, () =>
    client.listResources()
  )
  server.setRequestHandler(ReadResourceRequestSchema, (req) =>
    client.readResource(req.params)
  )
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
    client.listResourceTemplates()
  )

  const stdioTransport = new StdioServerTransport()

  // A stdio MCP server lives exactly as long as its stdio peer. The host
  // holds our stdin open; when it exits (cleanly or killed) that pipe closes
  // and stdin hits EOF. Exit on it — otherwise the parked promise below and
  // the keep-alive HTTP client transport outlive the parent, leaving one
  // orphaned bridge per session (ppid 1, ~35 MB each) until the host swaps.
  const shutdown = (code: number): never => {
    void client.close().catch(() => {})
    process.exit(code)
  }
  exitOnStdinClose(process.stdin, shutdown)
  // Also covers a transport-level close (e.g. an stdin read error) and a
  // parent that dies without closing an inherited stdin (POSIX reparenting).
  stdioTransport.onclose = () => shutdown(0)
  watchParentExit(shutdown)

  await server.connect(stdioTransport)

  process.stderr.write(
    `agentproto mcp-bridge: connected to ${url}, ` +
      `proxying ${toolCount} tool(s) over stdio\n`
  )

  // Park forever — the lifecycle hooks above stop the process when the stdio
  // peer disappears, so this promise is no longer what decides the lifetime.
  await new Promise<never>(() => {})
  // Unreachable — satisfies TS strict return check (Promise<never> never resolves).
  return 0
}

async function resolveDefaultUrl(): Promise<string> {
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  return `http://127.0.0.1:${port}/mcp`
}
