/**
 * `agentproto mcp-app <appId>` — stdio MCP server scoped to ONE installed
 * app's tools, for distributing an app (e.g. a book bundle) to buyers'
 * Codex/Cursor/Windsurf MCP clients without exposing the full daemon `/mcp`
 * gateway (~100 tools including `command_execute`, fs, `agent_*`).
 *
 * v1 is a thin proxy, reusing existing daemon primitives rather than
 * building new dispatch logic:
 *   - `findInstalledAppDir` / `readDeclaredExposedTools` (../app-serve.js)
 *     read the app's `exposes.tools` off its installed APP.md. Only the
 *     `--access` classes asked for are registered (default `read`), under the
 *     MCP-safe name `exposedToolName` computes, with the tool's real input
 *     schema and `readOnlyHint`/`destructiveHint` annotations.
 *   - An app with no `exposes.tools` keeps the previous behaviour (every
 *     `ui.tools` name, verbatim, generic `{ args }`) with a stderr warning.
 *   - Every call forwards the ORIGINAL tool id to the daemon's
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
import type { ZodRawShape } from "zod"
import { EXPOSED_TOOL_ACCESS, type AppExposedToolAccess } from "@agentproto/app"
import { loadConfig } from "@agentproto/runtime/config"
import { findInstalledAppDir, readDeclaredExposedTools, readDeclaredUITools } from "../app-serve.js"
import { runMcpAppHttp } from "./mcp-app-http.js"

const USAGE = `agentproto mcp-app <appId> — stdio MCP server scoped to one installed app

Usage:
  agentproto mcp-app <appId> [--access read[,write][,approve]]
  agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]
      standalone streamable-HTTP MCP App: the app's own bundled tools + its UI, no daemon

Registers the MCP tools the app declares under \`exposes.tools\` (APP.md
frontmatter), named <prefix>_<name>, each forwarding to the daemon's
POST /apps/:appId/tool-call route. Only the \`--access\` classes asked for are
registered; the default is read, so write and approve tools stay hidden until
you opt in. An app with no \`exposes.tools\` falls back to its whole
\`ui.tools\` allowlist (unclassified) with a warning. The app must already be
installed (\`agentproto app install <dir>\`) and declare one of the two;
mcp-app refuses to serve an app with neither rather than falling back to
exposing every daemon tool.

The daemon (\`agentproto serve\`) does not need to be running to start this
process — only to actually dispatch a tool call.
`

function parseArgs(args: readonly string[]): { appId?: string; access: Set<AppExposedToolAccess>; error?: string } {
  let appId: string | undefined
  let accessRaw = "read"
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--access") {
      const v = args[++i]
      if (v === undefined) return { access: new Set(), error: "--access needs a value" }
      accessRaw = v
    } else if (a.startsWith("--access=")) accessRaw = a.slice("--access=".length)
    else if (a.startsWith("-")) return { access: new Set(), error: `unknown flag ${a}` }
    else if (appId === undefined) appId = a
    else return { access: new Set(), error: `unexpected argument ${a}` }
  }
  const access = new Set<AppExposedToolAccess>()
  for (const part of accessRaw.split(",")) {
    if (!EXPOSED_TOOL_ACCESS.includes(part as AppExposedToolAccess)) {
      return { access, error: `--access takes ${EXPOSED_TOOL_ACCESS.join(", ")} (comma-separated), got "${part}"` }
    }
    access.add(part as AppExposedToolAccess)
  }
  return { ...(appId !== undefined ? { appId } : {}), access }
}

/** A JSON-Schema object's properties as a zod raw shape; undefined when it is not a flat object schema. */
function shapeFromInputs(inputs: Record<string, unknown> | undefined): ZodRawShape | undefined {
  if (!inputs) return undefined
  try {
    const schema = z.fromJSONSchema(inputs as Parameters<typeof z.fromJSONSchema>[0]) as { shape?: unknown }
    return schema.shape && typeof schema.shape === "object" ? (schema.shape as ZodRawShape) : undefined
  } catch {
    return undefined
  }
}

const GENERIC_ARGS_SHAPE: ZodRawShape = {
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the underlying tool."),
}

export async function runMcpApp(args: readonly string[]): Promise<number> {
  if (args[0] === "--http") return runMcpAppHttp(args.slice(1))
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const parsed = parseArgs(args)
  if (parsed.error) {
    process.stderr.write(`agentproto mcp-app: ${parsed.error}\n${USAGE}`)
    return 2
  }
  const appId = parsed.appId
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

  let exposed: Awaited<ReturnType<typeof readDeclaredExposedTools>>
  try {
    exposed = await readDeclaredExposedTools(appDir)
  } catch (err) {
    process.stderr.write(`agentproto mcp-app: invalid \`exposes.tools\`: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  let legacyTools: string[] | undefined
  if (exposed === undefined) {
    legacyTools = await readDeclaredUITools(appDir)
    if (legacyTools === undefined) {
      process.stderr.write(
        `agentproto mcp-app: app "${appId}" has no \`ui.tools\` allowlist declared in APP.md — ` +
          "mcp-app requires an explicit allowlist to scope what a buyer's MCP client can see. " +
          "Add `exposes: { prefix, tools: [...] }` (or `ui: { tools: [...] }`) to APP.md.\n",
      )
      return 1
    }
    process.stderr.write(
      `agentproto mcp-app: warning: app "${appId}" declares no \`exposes.tools\`; serving all ${legacyTools.length} ` +
        "`ui.tools` entries unclassified (read and write alike). Declare `exposes.tools` with an access class to scope it.\n",
    )
  }

  const toolCallUrl = `${await resolveDaemonBaseUrl()}/apps/${encodeURIComponent(appId)}/tool-call`

  const server = new McpServer({ name: `agentproto-mcp-app-${appId}`, version: "0.1.0" })

  let served = 0
  let hidden = 0
  if (exposed !== undefined) {
    for (const { entry, name, inputs } of exposed) {
      if (!parsed.access.has(entry.access)) {
        hidden++
        continue
      }
      const shape = shapeFromInputs(inputs)
      server.tool(
        name,
        entry.description,
        shape ?? GENERIC_ARGS_SHAPE,
        entry.access === "read" ? { readOnlyHint: true } : { destructiveHint: true },
        async (input: Record<string, unknown>) =>
          callScopedTool(toolCallUrl, entry.id, shape ? input : ((input.args as Record<string, unknown> | undefined) ?? {})),
      )
      served++
    }
  } else {
    for (const toolName of legacyTools ?? []) {
      server.tool(
        toolName,
        `Scoped proxy for installed app "${appId}"'s "${toolName}" tool (see the app's ui.tools allowlist).`,
        GENERIC_ARGS_SHAPE,
        async (input: Record<string, unknown>) =>
          callScopedTool(toolCallUrl, toolName, (input.args as Record<string, unknown> | undefined) ?? {}),
      )
      served++
    }
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(
    `agentproto mcp-app: serving ${served} tool(s) for app "${appId}" (dispatching to ${toolCallUrl})` +
      (hidden > 0 ? `; ${hidden} hidden by --access ${[...parsed.access].join(",")}` : "") +
      "\n",
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
