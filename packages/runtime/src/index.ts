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
import { registerSessionTools, registerExportSessionTool } from "./session-tools.js"
import {
  registerBrowserTools,
  type BrowserAdapterResolver,
  type BrowserAdapterLister,
} from "./browser-tools.js"
import { registerMcpApps } from "./mcp-apps-adapter.js"
import { makeSessionsPanelApp } from "./sessions-panel-app.js"
import {
  makeAgentsOverviewApp,
  registerSummarizeSessionTool,
} from "./agents-overview-app.js"
import { makeBureauSessionsApp } from "./bureau-sessions-app.js"
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
import { createRoutineRunner } from "./routine-runner.js"
import { createCompletionPolicySupervisor } from "./supervisor.js"
import { createInboundWatcher } from "./inbound-watcher.js"
export type {
  WatcherStartInput,
  WatcherDescriptor,
  InboundWatcher,
} from "./inbound-watcher.js"
import {
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  createOrchestratorInjector,
  type OrchestratorScope,
} from "./orchestrator-gateway.js"

export type {
  AgentAdapterResolver,
  AgentAdapterLister,
  AdapterListEntry,
} from "./http-server.js"
export type { BrowserAdapterResolver, BrowserAdapterLister, BrowserAdapterInfo } from "./browser-tools.js"
export { makeBrowserAdapterLister } from "./browser-adapters.js"
export type { BrowserAdapterHandle } from "./browser-adapters.js"
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
import { TunnelRegistry } from "./tunnel-registry.js"
import { registerTunnelTools } from "./tunnel-tools.js"
import { registerTunnelAdapterTools } from "./tunnel-adapters.js"
import { createWorkspaceFs, type WorkspaceFs } from "./workspace-fs.js"

export type { ConversationStore, ConversationMeta, ConversationTurn } from "./conversations.js"
export type { HeartbeatRunner, BuildHeartbeatAgent, HeartbeatAgent } from "./heartbeat.js"
export type { RuntimeEvent, RuntimeEvents } from "./events.js"
export type { WorkspaceFs } from "./workspace-fs.js"
export type { TunnelDescriptor, TunnelStatus, TunnelProvider } from "./tunnel-registry.js"
export { parseDuration } from "./heartbeat.js"
export { createWorkspaceFs } from "./workspace-fs.js"
export {
  sweepStaleRuntimeMetas,
  unlinkRuntimeMeta,
  readRuntimeMeta,
  daemonRegistryDir,
  readDaemonRegistry,
  sweepStaleDaemonRegistry,
  writeDaemonRegistryEntry,
  unlinkDaemonRegistryEntry,
  type RuntimeMeta,
} from "./agentproto-dir.js"
export { fileConversationStore } from "./conversations.js"
export {
  loadProviders,
  setProviderKey,
  removeProviderKey,
  injectProviderKeysIntoEnv,
  providerEnvVar,
  providersPath,
  PROVIDER_ENV_VARS,
  type ProviderEntry,
  type ProvidersFile,
} from "./providers-store.js"
export {
  DEFAULT_ORCHESTRATOR_TOOLS,
  narrowOrchestratorTools,
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  createOrchestratorInjector,
  type OrchestratorScope,
  type ScopeTokenRegistry,
  type OrchestratorMcpServerFactory,
  type OrchestratorGatewayDeps,
  type OrchestratorInjector,
  type OrchestratorInjection,
  type OrchestratorInjectorDeps,
} from "./orchestrator-gateway.js"

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
  /** Optional browser adapter resolver — when provided, enables the
   *  `start_browser` MCP tool (launches Camofox / Bureau / Chromium). */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Optional browser adapter lister — when provided, enables the
   *  `list_adapter_browsers` MCP tool. */
  listBrowserAdapters?: BrowserAdapterLister
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
  /** Tunnel registry — manages public cloudflared tunnels for any
   *  local port. Exposed so embedding hosts can open tunnels
   *  programmatically without going through the HTTP/MCP surface. */
  tunnels: TunnelRegistry
  /** Per-boot bearer token required on mutating /sessions/* routes
   *  + WS PTY upgrades. Exposed so an embedding host (e.g. the CLI
   *  shell that hosts the gateway in-process) can pass it to child
   *  tools without re-reading the runtime.json file. */
  token: string
  /** Mint a scope-token for the scoped orchestrator sub-gateway
   *  (`/mcp/orchestrator`). The returned `token` gates that endpoint
   *  and `tools` is the effective allowlist (⊆ the default orchestrator
   *  subset). WP3 will call this at spawn time and inject the URL into
   *  the child's `mcpServers`; for WP2 it's the internal primitive. */
  mintOrchestratorScope(opts?: {
    tools?: readonly string[]
  }): OrchestratorScope
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

  // Multi-tunnel registry — independent from RemoteController. Manages
  // the general "create a public URL for any local port" surface
  // (create_tunnel / list_tunnels / stop_tunnel MCP tools + /tunnels HTTP
  // routes). Logs flow through the same events stream.
  const tunnels = new TunnelRegistry({
    workspace,
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
  })
  // Relaunch any `autostart` (named) tunnels that were live before this
  // daemon restarted. Non-blocking — boot must not wait on cloudflared,
  // and a failed restore leaves that one tunnel `error` without gating
  // the rest of the gateway.
  void tunnels.restoreOnBoot().catch(() => {
    // restoreOnBoot already logs per-tunnel failures via onLog.
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
  // Unregister per-session URLs on exit so the notifier map doesn't
  // leak memory across sessions.
  sessionEvents.on("session:exited", ev => {
    webhookNotifier.unregister(ev.sessionId)
  })

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
          resumeAgent: async ({
            adapterSlug,
            cwd,
            resumeSessionId,
            mcpServers,
          }) => {
            const adapter = await opts.resolveAgentAdapter!(adapterSlug)
            if (!adapter) return null
            try {
              return await adapter.startSession({
                cwd,
                resumeSessionId,
                // Re-mount the persisted spawn-time toolset on resume
                // (orchestrator WP1) — closes the gap where re-spawn
                // dropped mcpServers.
                ...(mcpServers ? { mcpServers } : {}),
              })
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
    persist: true,
    // WP6: daemon-wide cap on policies concurrently gating/acting. Excess
    // queue (FIFO) until a slot frees. Override via AGENTPROTO_POLICY_CONCURRENCY.
    concurrencyCap: (() => {
      const raw = process.env.AGENTPROTO_POLICY_CONCURRENCY
      const n = raw ? Number.parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n > 0 ? n : undefined
    })(),
    // WP7: judge-agent gate spawns a short-lived agent via the same resolver
    // start_agent_session uses. Absent → judge gates fail-safe (FAIL).
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
  })

  // Routine runner — singleton per daemon, shared across all MCP connections.
  // Persists run state to ~/.agentproto/routine-runs.json so runs survive
  // daemon restarts (interrupted runs are marked "failed" on load).
  // Declared after `sessions` and `supervisor` so it shares the same
  // registry + event bus. Only wired when `resolveAgentAdapter` is
  // available (routine steps need to spawn agent sessions).
  const routineRunner = opts.resolveAgentAdapter
    ? createRoutineRunner({
        registry: sessions,
        sessionEvents,
        resolveAgentAdapter: opts.resolveAgentAdapter,
        webhookNotifier,
        persist: true,
      })
    : undefined

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

  // Inbound watcher — polls an agentpush source on a timer and spawns
  // one agent per new contact_ref. Wired when an adapter resolver is
  // available (otherwise the watcher would have nowhere to spawn).
  const inboundWatcher =
    opts.resolveAgentAdapter
      ? createInboundWatcher({
          mcpProxy,
          registry: sessions,
          resolveAgentAdapter: opts.resolveAgentAdapter,
          persist: true,
        })
      : undefined

  // Scope-token registry (WP2) — mints/validates the per-child tokens
  // that gate `/mcp/orchestrator` and carry each orchestrator's identity
  // (owner session, depth, tools, limits — WP4). The injector + scoped
  // factory below both close over it.
  const scopeTokens = createScopeTokenRegistry()

  // Orchestrator auto-injection (WP3). Closed over the scope-token
  // registry + the session-event bus + the HTTP port: when
  // `start_agent_session` is called with `orchestrator`, this mints a
  // scoped token, builds the `mcpServers` entry pointing the child at
  // `/mcp/orchestrator?scope=<token>` on the daemon's own loopback
  // port, and revokes the token on the child's `session:exited`. The
  // port is the daemon's configured listener port (`startHttpServer`
  // binds `opts.port` directly), reachable by the co-located child
  // over loopback.
  // The injected entry is named "agentproto" (the default) so the
  // child's orchestration tools surface under a stable namespace,
  // independent of the daemon's advertised server name.
  // Defined BEFORE the scoped factory so the factory can hand it to the
  // scoped server's `start_agent_session` — that's what lets a child
  // orchestrator recursively spawn its OWN sub-orchestrators (WP4),
  // bounded by depth/quota/tools inheritance.
  const orchestratorInjector = createOrchestratorInjector({
    scopeTokens,
    sessionEvents,
    port,
  })

  // Scoped orchestrator sub-gateway (WP2). The scope-token registry
  // mints/validates per-child tokens; the factory builds a scoped MCP
  // server exposing only the curated orchestration subset for a verified
  // scope. Mounted by the HTTP server at `/mcp/orchestrator` (no
  // loopback bypass — token required). The verified scope is also the
  // calling orchestrator's identity, so the scoped server enforces the
  // WP4 depth/quota guards + subtree scoping against it.
  const orchestratorMcpServerFactory = createOrchestratorMcpServerFactory({
    workspace,
    name: opts.name ?? "agentproto-runtime",
    version: opts.version ?? "0.1.0-alpha",
    registry: sessions,
    sessionEvents,
    eventRing,
    supervisor,
    orchestratorInjector,
    webhookNotifier,
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
  })

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
      buildOrchestratorMcp: orchestratorInjector,
      webhookNotifier,
      ...(opts.resolveAgentAdapter
        ? { resolveAgentAdapter: opts.resolveAgentAdapter }
        : {}),
      ...(opts.listAgentAdapters
        ? { listAgentAdapters: opts.listAgentAdapters }
        : {}),
    })
    registerBrowserTools(server, {
      registry: sessions,
      ...(opts.resolveBrowserAdapter
        ? { resolveBrowserAdapter: opts.resolveBrowserAdapter }
        : {}),
      ...(opts.listBrowserAdapters
        ? { listBrowserAdapters: opts.listBrowserAdapters }
        : {}),
    })
    registerOrchestrationTools(server, {
      registry: sessions,
      sessionEvents,
      eventRing,
      supervisor,
      ...(routineRunner ? { routineRunner } : {}),
      ...(inboundWatcher ? { inboundWatcher } : {}),
    })
    // MCP Apps — agentproto_sessions panel via the AgnoMcpApp adapter.
    // Tool: agentproto_sessions  Resource: ui://agentproto_sessions/view
    const listSessionsFiltered = (filter?: "running" | "all") => {
      let rows = sessions.list()
      if (filter === "running") {
        rows = rows.filter(s => s.status === "running" || s.status === "starting")
      }
      return rows
    }
    registerMcpApps(server, [
      makeSessionsPanelApp({ listSessions: listSessionsFiltered }),
      makeAgentsOverviewApp({ listSessions: listSessionsFiltered }),
      makeBureauSessionsApp({ listSessions: listSessionsFiltered }),
    ])
    // Server-side per-session summariser backing the agents-overview panel.
    // Heuristic today (no LLM in @agentproto/runtime) — see agents-overview-app.ts.
    registerSummarizeSessionTool(server, {
      getSession: (id) => sessions.get(id),
      tailLines: (id, lastN) => {
        // Same source as get_agent_session_output: attach replays the ring
        // buffer synchronously, then we unsubscribe immediately.
        const lines: string[] = []
        const unsub = sessions.attach(id, (line) => { lines.push(line) })
        if (unsub) unsub()
        return lines.slice(-lastN)
      },
    })
    // Transcript exporter — reads the adapter's native persistence
    // (claude-code JSONL / hermes SQLite) and renders a clean markdown or
    // JSON transcript. Co-located with the session tools; registry access
    // mirrors the summarise_session pattern above.
    registerExportSessionTool(server, { registry: sessions })
    // Multi-tunnel tools — same closure-rebind pattern.
    registerTunnelTools(server, { registry: tunnels })
    // Tunnel adapter introspection/setup, riding on @agentproto/adapter-kit
    // (list_tunnel_adapters + setup_tunnel_provider). Stateless wrt the
    // gateway — creds/ledger live under ~/.agentproto.
    registerTunnelAdapterTools(server, {})
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
    orchestratorMcpServerFactory,
    verifyOrchestratorScope: scopeTokens.verify,
    conversations,
    events,
    heartbeat,
    sessions,
    mcpProxy,
    token,
    ptyEnabled: opts.spawnPty != null,
    tunnels,
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.strictOrigins ? { strictOrigins: true } : {}),
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
    ...(opts.resolveBrowserAdapter
      ? { resolveBrowserAdapter: opts.resolveBrowserAdapter }
      : {}),
    ...(opts.listBrowserAdapters
      ? { listBrowserAdapters: opts.listBrowserAdapters }
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
    tunnels,
    token,
    mintOrchestratorScope: scopeTokens.mint,
    async stop() {
      heartbeat.stop()
      // Flush inbound-watcher cursor state before sessions shut down.
      inboundWatcher?.shutdown()
      // Flush completion-policy state before sessions shut down so
      // policies referencing live sessions are persisted with their
      // current status (not "killed" sessions).
      supervisor.shutdown()
      // Kill all live sessions before tearing down HTTP — otherwise
      // long-running children inherit the daemon's listening socket
      // and stay around as zombies after the parent exits.
      sessions.shutdown()
      // Close upstream MCP clients (their stdio children would
      // otherwise leak the same way).
      await mcpProxy.closeAll()
      // Stop all active tunnels (TunnelRegistry) then the remote
      // controller's single-gateway tunnel. Both before HTTP so
      // cloudflared doesn't briefly proxy to a dead port.
      await tunnels.shutdown()
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
