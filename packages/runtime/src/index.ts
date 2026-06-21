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

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import type { DoctypeSpec } from "@agentproto/manifest"

import { writeRuntimeMeta } from "./agentproto-dir.js"
import { registerCommandTools } from "./command-tools.js"
import { fileConversationStore } from "./conversations.js"
import { createRuntimeEvents } from "./events.js"
import { registerFsTools } from "./fs-tools.js"
import { registerSessionTools } from "./session-tools.js"
import { startHeartbeat, type BuildHeartbeatAgent } from "./heartbeat.js"
import {
  startHttpServer,
  type AuthOptions,
  type AgentAdapterResolver,
  type AgentAdapterLister,
} from "./http-server.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type PtyFactory,
} from "./sessions.js"
import { McpProxyRegistry } from "./mcp-proxy.js"
import { registerOrchestrationTools } from "./orchestration-tools.js"
import { createSessionEventBus } from "./session-event-bus.js"
import { createEventRing } from "./event-ring.js"
import { createWebhookNotifier } from "./webhook-notifier.js"
import { createCompletionPolicySupervisor } from "./supervisor.js"

export type {
  AgentAdapterResolver,
  AgentAdapterLister,
  AdapterListEntry,
} from "./http-server.js"
export type {
  AgentSessionLike,
  AgentStreamEvent,
  SessionDescriptor,
  SessionKind,
  SessionStatus,
  SpawnSessionInput,
  SpawnAgentInput,
  SessionsRegistry,
  RegisterBrowserInput,
  RegisterSessionInput,
} from "./sessions.js"
import { RemoteController } from "./remote-controller.js"
import { registerRemoteTools } from "./remote-tools.js"
import { createWorkspaceFs, type WorkspaceFs } from "./workspace-fs.js"

export type { ConversationStore, ConversationMeta, ConversationTurn } from "./conversations.js"
export type { HeartbeatRunner, BuildHeartbeatAgent, HeartbeatAgent } from "./heartbeat.js"
export type { RuntimeEvent, RuntimeEvents } from "./events.js"
export type { WorkspaceFs } from "./workspace-fs.js"
export { parseDuration } from "./heartbeat.js"
export { createWorkspaceFs } from "./workspace-fs.js"
export {
  sweepStaleRuntimeMetas,
  unlinkRuntimeMeta,
  readRuntimeMeta,
  type RuntimeMeta,
} from "./agentproto-dir.js"
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
  /** Optional adapter resolver — when provided, enables
   *  `POST /sessions/agent` (long-running agent CLIs like
   *  claude-code / hermes via the @agentproto/cli adapter system).
   *  Without this, /sessions still works for raw `argv` spawns. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when provided, enables
   *  `GET /adapters` HTTP route + `list_adapters` MCP tool so UIs
   *  can discover what's installed on the host. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional PTY factory (node-pty wrapper, typically from the cli
   *  layer's `loadNodePtyFactory()`). When provided, enables
   *  `POST /sessions/terminal`, the `start_terminal_session` MCP
   *  tool family, and the `/sessions/:id/pty` WebSocket. Without it,
   *  those routes return 501 / the MCP tools aren't registered. */
  spawnPty?: PtyFactory
  /** Override the per-boot bearer token. Default: `randomUUID()`.
   *  Tests can pin a known value; production should always let
   *  the gateway generate fresh. The token is written into
   *  `<workspace>/.agentproto/runtime.json` (mode 0600) and required
   *  on mutating `/sessions/*` routes + the PTY WS upgrade. */
  token?: string
  /** Trusted browser origins allowed to drive mutating routes
   *  without a bearer token. See `RuntimeHttpServerOptions.allowedOrigins`
   *  for match semantics. Default: localhost on any port. */
  allowedOrigins?: readonly string[]
  /** When true, drop the localhost-wildcard defaults — only the
   *  explicit `allowedOrigins` list is honoured. */
  strictOrigins?: boolean
}

export interface GatewayHandle {
  url: string
  workspace: string
  workspaceFs: WorkspaceFs
  registered: readonly string[]
  /** Sessions registry — exposed so MCP tools / external spawners
   *  inside the same process can register their child processes for
   *  visibility through /sessions and the CLI TUI. */
  sessions: SessionsRegistry
  /** Per-boot bearer token required on mutating /sessions/* routes
   *  + WS PTY upgrades. Exposed so an embedding host (e.g. the CLI
   *  shell that hosts the gateway in-process) can pass it to child
   *  tools without re-reading the runtime.json file. */
  token: string
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

  // Singleton controller for "publish to the internet" state. Created
  // disabled — auth stays `mode: "none"` until `remote_enable` is
  // called. Tunnel logs flow through the events stream so `/events`
  // subscribers see cloudflared chatter.
  const remote = new RemoteController({
    workspace,
    port,
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
  })

  // Build a server once eagerly so we can capture `registered` for
  // `/health`. The server is NOT used for serving — every `/mcp`
  // request gets its own freshly-constructed pair, mirroring the
  // SDK's official stateless pattern. See the comment on
  // `RuntimeHttpServerOptions.mcpServerFactory` for why.
  const { registered } = await createMcpServer({
    specs: opts.specs,
    workspace,
    name: opts.name ?? "agentproto-runtime",
    version: opts.version ?? "0.1.0-alpha",
  })

  // Event bus + ring for orchestration tools (poll_events / wait_for_any).
  // Declared before the sessions registry so we can pass the bus into it.
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  // Wire the ring so every session:* event is buffered for poll_events.
  eventRing.wire(sessionEvents)
  // Wire the webhook notifier so per-session and global URLs are
  // notified on turn-end / awaiting-input / exited events.
  const webhookNotifier = createWebhookNotifier()
  sessionEvents.onAny(ev => webhookNotifier.onSessionEvent(ev))

  // Sessions registry — single instance per gateway, captured by
  // the per-request mcpServerFactory closure below + handed to
  // startHttpServer for the /sessions HTTP routes. Declared here
  // (above the factory) so its identifier is visible at closure-
  // build time, even though the factory only invokes later.
  const sessions = createSessionsRegistry({
    sessionEvents,
    ...(opts.spawnPty ? { spawnPty: opts.spawnPty } : {}),
    // Resume hook: when a prompt arrives for a dead agent-cli row
    // (typical after daemon restart), the registry calls back into
    // the adapter resolver to re-create the AgentSession with
    // `resumeSessionId = adapterSessionId`. ACP semantics: the
    // upstream provider reattaches to the prior conversation.
    // Unwired (no resolveAgentAdapter) → legacy "not an agent
    // session" error, user must spawn fresh.
    ...(opts.resolveAgentAdapter
      ? {
          resumeAgent: async ({ adapterSlug, cwd, resumeSessionId }) => {
            const adapter = await opts.resolveAgentAdapter!(adapterSlug)
            if (!adapter) return null
            try {
              return await adapter.startSession({ cwd, resumeSessionId })
            } catch (err) {
              console.warn(
                `[agentproto] resumeAgent('${adapterSlug}', ${resumeSessionId}) failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
              return null
            }
          },
        }
      : {}),
  })

  // Completion-policy supervisor — watches sessions and runs shell gates.
  // Declared after `sessions` so it can resolve session cwd at gate time.
  const supervisor = createCompletionPolicySupervisor({
    registry: sessions,
    sessionEvents,
    workspace,
  })

  // Per-boot bearer token. Required on mutating /sessions/* routes
  // and on the WS upgrade for /sessions/:id/pty. Persisted to
  // runtime.json (mode 0600) so the same-user CLI can read it; a
  // browser-loaded localhost page can't.
  const token = opts.token ?? randomUUID()

  // MCP proxy — single registry that holds open Client connections
  // to every imported MCP server. The per-request mcpServerFactory
  // captures it so each /mcp request reuses the same upstream
  // sessions instead of re-spawning stdio children.
  const mcpProxy = new McpProxyRegistry()

  const mcpServerFactory = async () => {
    const { server } = await createMcpServer({
      specs: opts.specs,
      workspace,
      name: opts.name ?? "agentproto-runtime",
      version: opts.version ?? "0.1.0-alpha",
    })
    // Canonical filesystem tools so remote MCP clients (cloud
    // workspace-providers, IDEs, ad-hoc tooling) can read/write the
    // workspace without each implementing AIP-aware glue. Names match
    // `@modelcontextprotocol/server-filesystem` for drop-in compat.
    registerFsTools(server, { workspace })
    // Subprocess execution — the runtime's superpower for cloud
    // agents. Any allowlisted CLI on the user's machine (claude, gh,
    // pnpm, …) is reachable via `execute_command`. Allowlist lives at
    // `.agentproto/allowed-commands.json`; default-deny.
    registerCommandTools(server, { workspace })
    // Remote-tunnel lifecycle. The controller is a singleton on the
    // gateway, so registering its tools per-request is just rebinding
    // the same closures — the underlying state lives in `remote`.
    registerRemoteTools(server, { controller: remote })
    // Agent-session orchestration — operators (Mastra agents in
    // cloud Guilde, Claude Code as a sub-agent, …) drive long-running
    // claude/hermes/aider sessions on the user's machine through
    // these MCP tools. The registry + adapter resolver are
    // singletons on the gateway, same closure-rebind pattern.
    registerSessionTools(server, {
      registry: sessions,
      mcpProxy,
      ptyEnabled: opts.spawnPty != null,
      ...(opts.resolveAgentAdapter
        ? { resolveAgentAdapter: opts.resolveAgentAdapter }
        : {}),
      ...(opts.listAgentAdapters
        ? { listAgentAdapters: opts.listAgentAdapters }
        : {}),
    })
    registerOrchestrationTools(server, { registry: sessions, sessionEvents, eventRing, supervisor })
    return server
  }

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
    // Auth is read on every request via this getter. `opts.auth`
    // (when provided) is the startup default and represents the
    // operator's intent — bearer-only deployments stay bearer-only
    // even when no remote tunnel is up. The controller's auth wins
    // once a tunnel is enabled (it issues a fresh token); on disable
    // we fall back to `opts.auth` if set, otherwise `mode: "none"`.
    auth: () => {
      const remoteAuth = remote.readAuth()
      if (remoteAuth.mode === "bearer") return remoteAuth
      return opts.auth ?? { mode: "none" }
    },
    mcpServerFactory,
    conversations,
    events,
    heartbeat,
    sessions,
    mcpProxy,
    token,
    ptyEnabled: opts.spawnPty != null,
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.strictOrigins ? { strictOrigins: true } : {}),
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
    meta: { workspace, registered },
  })

  heartbeat.start()
  events.emit({
    type: "boot",
    at: new Date().toISOString(),
    workspace,
    registered,
  })

  // Record a snapshot of the running config so external tooling /
  // shell users can introspect a live gateway via
  // `cat <workspace>/.agentproto/runtime.json`. Best-effort — failure
  // here doesn't gate the gateway being functional.
  void writeRuntimeMeta(workspace, {
    workspace,
    port,
    bind: opts.bind ?? "127.0.0.1",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    name: opts.name ?? "agentproto-runtime",
    registered,
    token,
  })

  return {
    url: http.url,
    workspace,
    workspaceFs,
    registered,
    sessions,
    token,
    async stop() {
      heartbeat.stop()
      // Kill all live sessions before tearing down HTTP — otherwise
      // long-running children inherit the daemon's listening socket
      // and stay around as zombies after the parent exits.
      sessions.shutdown()
      // Close upstream MCP clients (their stdio children would
      // otherwise leak the same way).
      await mcpProxy.closeAll()
      // Tear the tunnel before the HTTP listener — otherwise cloudflared
      // briefly proxies to a dead port and surfaces 502s to any in-flight
      // remote client.
      await remote.shutdown()
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
