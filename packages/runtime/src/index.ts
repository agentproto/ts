/**
 * @agentproto/runtime — long-running gateway around an agentproto
 * workspace dir.
 *
 * Composes:
 *   - `@agentproto/mcp-server` (CRUD verbs over registered specs)
 *   - HTTP transport (Streamable HTTP) on a configurable port
 *   - HEARTBEAT.md autonomy loop
 *   - Append-only conversation persistence (`conversations/<id>.md`)
 *   - Workspace filesystem adapter (compatible with the
 *     `McpWorkspace.filesystem` shape used by `@guilde/mcp`)
 *
 * Single entry point: `createGateway(opts)`. Returns a handle with
 * `url` and `stop()` — the rest of the surface lives on the HTTP
 * server.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import type { DoctypeSpec } from "@agentproto/manifest"

import { fileConversationStore } from "./conversations.js"
import { createRuntimeEvents } from "./events.js"
import { startHeartbeat, type BuildHeartbeatAgent } from "./heartbeat.js"
import { startHttpServer, type AuthOptions } from "./http-server.js"
import { createWorkspaceFs, type WorkspaceFs } from "./workspace-fs.js"

export type { ConversationStore, ConversationMeta, ConversationTurn } from "./conversations.js"
export type { HeartbeatRunner, BuildHeartbeatAgent, HeartbeatAgent } from "./heartbeat.js"
export type { RuntimeEvent, RuntimeEvents } from "./events.js"
export type { WorkspaceFs } from "./workspace-fs.js"
export { parseDuration } from "./heartbeat.js"
export { createWorkspaceFs } from "./workspace-fs.js"
export { fileConversationStore } from "./conversations.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = DoctypeSpec<any, any>

export interface CreateGatewayOptions {
  /** Absolute path to the workspace dir. */
  workspace: string
  /** AIP doctype specs to expose as MCP CRUD verbs. */
  specs: readonly AnySpec[]
  /** Port to bind. Default 18790. */
  port?: number
  /** Bind host. Default `127.0.0.1` (loopback). Set `0.0.0.0` for LAN. */
  bind?: string
  /** Auth mode. Default `none` (safe only on loopback). */
  auth?: AuthOptions
  /**
   * Resolves a heartbeat-runnable agent from its workspace id.
   * Required for HEARTBEAT.md to do anything; without it ticks emit
   * `heartbeat-error` events instead of generating.
   */
  buildAgent?: BuildHeartbeatAgent
  /** Server name advertised over MCP. */
  name?: string
  /** Server version advertised over MCP. */
  version?: string
  /**
   * Run BOOT.md once at startup. Pass `false` to disable. Defaults to
   * `true`. The boot file is plain markdown — frontmatter-free; the
   * agent named in `defaultBootAgent` (or skipped if unset) gets the
   * body as a single prompt and the reply is appended to a `boot-<iso>`
   * conversation.
   */
  boot?: boolean
  /** Agent id used for BOOT.md if no per-file frontmatter. */
  defaultBootAgent?: string
}

export interface GatewayHandle {
  url: string
  workspace: string
  workspaceFs: WorkspaceFs
  registered: readonly string[]
  stop(): Promise<void>
}

/**
 * Spin up the gateway. Order:
 *   1. Build MCP server + load AIP-40 extensions
 *   2. Build conversation store + workspace fs adapter
 *   3. (optional) Run BOOT.md once
 *   4. Start HTTP server
 *   5. Start heartbeat ticker
 *
 * `stop()` reverses 4–5 (heartbeat first, then HTTP). The MCP server
 * is owned by the HTTP server's per-session transports and is closed
 * implicitly when those close.
 */
export async function createGateway(
  opts: CreateGatewayOptions,
): Promise<GatewayHandle> {
  const workspace = resolve(opts.workspace)
  if (!existsSync(workspace)) {
    throw new Error(`runtime: workspace dir does not exist: ${workspace}`)
  }
  const port = opts.port ?? 18790

  const events = createRuntimeEvents()
  const conversations = fileConversationStore({ workspace })
  const workspaceFs = createWorkspaceFs({ workspace })

  const { server: mcpServer, registered } = await createMcpServer({
    specs: opts.specs,
    workspace,
    name: opts.name ?? "agentproto-runtime",
    version: opts.version ?? "0.1.0-alpha",
  })

  // ── boot ─────────────────────────────────────────────────────────
  if (opts.boot !== false) {
    await runBoot(workspace, opts, conversations, events).catch((err) => {
      events.emit({
        type: "heartbeat-error",
        at: new Date().toISOString(),
        agent: opts.defaultBootAgent,
        error: `BOOT.md failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    })
  }

  const heartbeat = startHeartbeat({
    workspace,
    conversations,
    events,
    buildAgent: opts.buildAgent ?? noopBuildAgent,
  })

  const http = await startHttpServer({
    port,
    bind: opts.bind,
    auth: opts.auth,
    mcpServer,
    conversations,
    events,
    heartbeat,
    meta: { workspace, registered },
  })

  heartbeat.start()
  events.emit({
    type: "boot",
    at: new Date().toISOString(),
    workspace,
    registered,
  })

  return {
    url: http.url,
    workspace,
    workspaceFs,
    registered,
    async stop() {
      heartbeat.stop()
      await http.stop()
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const noopBuildAgent: BuildHeartbeatAgent = async () => null

async function runBoot(
  workspace: string,
  opts: CreateGatewayOptions,
  conversations: import("./conversations.js").ConversationStore,
  events: import("./events.js").RuntimeEvents,
): Promise<void> {
  const path = join(workspace, "BOOT.md")
  if (!existsSync(path)) return
  const body = (await readFile(path, "utf8")).trim()
  if (!body) return
  if (!opts.buildAgent || !opts.defaultBootAgent) return

  const agent = await opts.buildAgent(opts.defaultBootAgent)
  if (!agent) return

  const conversationId = `boot-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}`
  await conversations.open(conversationId, { agent: opts.defaultBootAgent })
  await conversations.appendTurn(conversationId, "user", body, {
    attribution: "boot",
  })
  const reply = await agent.generate(body)
  await conversations.appendTurn(conversationId, "assistant", reply.text, {
    attribution: opts.defaultBootAgent,
  })
  events.emit({
    type: "heartbeat-fired",
    at: new Date().toISOString(),
    agent: opts.defaultBootAgent,
    conversationId,
    prompt: body,
    reply: reply.text,
    durationMs: 0,
  })
}
