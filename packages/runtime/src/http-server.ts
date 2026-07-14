/**
 * Tiny node:http server that fronts the runtime gateway.
 *
 * Routes:
 *   GET  /health              — { status, workspace, registered, uptime }
 *   GET  /events              — SSE stream of RuntimeEvent
 *   POST /mcp                 — MCP Streamable HTTP transport (POST)
 *   GET  /mcp                 — MCP SSE response stream (GET)
 *   DELETE /mcp               — close MCP session
 *   GET  /conversations       — JSON list of conversation summaries
 *   GET  /conversations/<id>  — markdown body of one conversation
 *   POST /heartbeat/tick      — force-fire one heartbeat tick
 *
 * No auth in `mode: "none"` (loopback default). `mode: "bearer"`
 * checks `Authorization: Bearer <token>` against the configured
 * token. Health is always public so external monitors can probe.
 *
 * MCP transport: stateless mode for v1 — each request is independent.
 * Stateful session pinning can come later when long-running streaming
 * tool calls become a real use case.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import type { AcpMcpServer } from "@agentproto/acp"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { WebSocketServer, type WebSocket } from "ws"
import type { ConversationStore } from "./conversations.js"
import type { HeartbeatRunner } from "./heartbeat.js"
import type { RuntimeEvents, RuntimeEvent } from "./events.js"
import type { SessionsRegistry, AgentSessionLike } from "./sessions.js"
import { SessionNotAliveError } from "./sessions.js"
import type { TunnelRegistry } from "./tunnel-registry.js"
import type { PairingRegistry } from "./pairing-registry.js"
import type { RoutineRunner, RoutineStep } from "./routine-runner.js"
import type { WorkflowRunner, WorkflowStage } from "./workflow-runner.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"
import { discoverMcps } from "./mcp-discovery.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import type {
  BrowserAdapterResolver,
  BrowserAdapterLister,
} from "./browser-tools.js"
import type {
  OrchestratorScope,
  OrchestratorMcpServerFactory,
} from "./orchestrator-gateway.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"
import { exportAgentSession } from "./transcript-export.js"
import { sessionEventsPath } from "./transcript-writer.js"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import {
  monitorSessionWait,
  monitorPolicyWait,
  type SessionWaitEvent,
} from "./orchestration-tools.js"
import type {
  SessionEventBus,
  SessionEventType,
} from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { CompletionPolicySupervisor, AttachPolicyInput } from "./supervisor.js"
import type {
  DeclaredAdapterOption,
  AdapterAuthDescriptor,
  ResolvedAuthSpec,
} from "./spawn-defaults.js"
import { spawnAgentSession, type BuildOrchestratorMcp } from "./session-spawn.js"
import { tryParseJson } from "./json-tolerant.js"
import { listPresets } from "./preset-tools.js"

/**
 * Default Origin allowlist used when `RuntimeHttpServerOptions.allowedOrigins`
 * is undefined. Localhost on any port covers the user's own dev environments
 * (Guilde web dev server, playground demos, embedded panels). Production
 * origins (https://guilde.work, …) are NOT included by default — those are
 * opt-in via `agentproto serve --allow-origin <url>`.
 */
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  // The canonical hosted agentproto panel (github.com/agentproto/cli-site,
  // deployed at cli.agentproto.sh). It drives the user's OWN local daemon
  // from the browser: read-only GETs (session list, SSE stream) are ungated
  // and already work, but the /sessions/:id/pty WebSocket upgrade IS gated —
  // so a PTY terminal in the panel 401s unless this first-party origin is
  // trusted like localhost. A malicious page can't forge this Origin (the
  // browser sets it), so the trust is scoped to agentproto's own panel,
  // matching how guilde.work is trusted. Drop it via `strictOrigins`.
  "https://cli.agentproto.sh",
]

/**
 * Pluggable adapter resolver — keeps the runtime package free of any
 * @agentproto/cli dep. The host (cli `serve`, playground, embedding
 * apps) builds the resolver and hands it in. Returning null means
 * "adapter not found" → 404.
 */
export type AgentAdapterResolver = (slug: string) => Promise<{
  /** Build a fresh AgentSessionLike for the given cwd. The driver
   *  spawns the adapter binary, opens the protocol, and the
   *  registry holds the result.
   *
   *  When `resumeSessionId` is set, the driver reattaches to that
   *  pre-existing adapter session (claude-code's conversation id,
   *  hermes' chat handle, …) rather than starting blank. Same
   *  mechanism as `agentproto run --resume <id>` — exposed over
   *  HTTP so `agentproto sessions restart` works on agent-cli
   *  sessions, not just PTY ones. */
  startSession(opts: {
    cwd: string
    resumeSessionId?: string
    /**
     * Manifest-declared mode id forwarded from `agent_start` (AIP-45
     * `AgentCliHandle.modes` — e.g. claude-code's `plan` /
     * `accept-edits` / `bypass-permissions`, codex's `read-only`,
     * mastracode/opencode's `plan`). Applied at spawn time via
     * `composeSpawn`'s mode patch (`bin_args_append` / `env`) — BEFORE
     * the child process is exec'd, unlike `model`/`effort` below.
     * Adapters with no declared `modes` (e.g. hermes) ignore it; an
     * unknown id for an adapter that DOES declare modes throws
     * `RuntimeConfigError` (composeSpawn validates against the
     * manifest, so a typo fails the spawn rather than silently no-op).
     */
    mode?: string
    /**
     * Manifest-declared option id → value map forwarded from
     * `agent_start` (AIP-45 `AgentCliHandle.options` — e.g. hermes'
     * `skills`). Applied at spawn time via `composeSpawn`'s option
     * patches (`bin_args_prepend` / `bin_args_template` /
     * `bin_args_append_when_true` / `env`), validated against each
     * option's declared `type`/`enum`/`min`/`max`. An id the adapter
     * doesn't declare throws `RuntimeConfigError` (composeSpawn
     * validates against the manifest, same as an unknown `mode`).
     */
    options?: Record<string, boolean | number | string>
    /** Model identifier forwarded from `agent_start`. For ACP
     *  adapters this is applied via session/set_config_option after
     *  newSession (the ACP wrapper does not forward CLI args to claude).
     *  Adapters that don't support model selection ignore it. */
    model?: string
    /** Effort level forwarded from `agent_start`. Effort is
     *  model-dependent — same label ≠ same budget across models; defaults
     *  differ by model. Omit to keep the model's own default. Applied
     *  via session/set_config_option on ACP adapters; others ignore it. */
    effort?: string
    /** MCP servers to mount into the spawned agent's session at spawn
     *  time. Forwarded verbatim to the driver's `start({ mcpServers })`
     *  → the ACP arm's `session/new.mcpServers`, giving the child agent
     *  a host-chosen scoped toolset (e.g. the daemon's own orchestration
     *  gateway). Adapters that don't model MCP mounting ignore it. */
    mcpServers?: AcpMcpServer[]
    /** Called on any adapter-process activity (ACP JSON-RPC traffic in
     *  either direction) — forwarded to the driver's
     *  `runtime.start({ onActivity })`. The caller (agent_start's MCP
     *  handler, POST /sessions/agent) wires this to pulse
     *  `SessionDescriptor.lastActivityAt` via `registry.pulseActivity(id)`. */
    onActivity?: () => void
    /** Start the session in permission-hold mode — forwarded to the driver's
     *  `runtime.start({ permissionHold })` so each ACP permission request is
     *  surfaced + parked in the daemon's inbox instead of auto-answered.
     *  Adapters/arms with no permission surface ignore it. Default false. */
    permissionHold?: boolean
    /** FULLY-RESOLVED billing-auth spec forwarded from `agent_start` to the
     *  driver's `runtime.start({ auth })`, computed by the runtime's
     *  `resolveAuthSpec` (provider, ordered mode, setEnv/scrub, credential
     *  source all pre-decided). The driver applies it mechanically. Absent
     *  when the resolver produced no spec (ambient). */
    auth?: ResolvedAuthSpec
  }): Promise<AgentSessionLike>
  /** Display label for the descriptor's `command` field. */
  commandPreview?: string
  /** Best-effort per-session usage reader (adapter-specific, e.g. hermes state.db). */
  readUsage?: (adapterSessionId: string) => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** AIP-45 `options[]` this adapter's manifest declares (id + type only —
   *  no spawn internals). Lets `session-spawn.ts` fold a config-level
   *  `defaults.skills` list into `options.skills` using the shape the
   *  manifest actually declared (e.g. hermes' comma-joined string),
   *  instead of guessing. Omitted/empty ⇒ the skills normalization is a
   *  documented no-op for that adapter (e.g. claude-code, which
   *  auto-discovers skills and declares no such option). */
  declaredOptions?: readonly DeclaredAdapterOption[]
  /** Billing-auth descriptor projected from the adapter manifest
   *  (`provider` / `authEnforce` / `authSubscription`) — the sole input the
   *  runtime's `resolveAuthSpec` reads about the adapter's auth capability
   *  (keeping the catalog coupling in the runtime, the driver mechanical).
   *  Omitted ⇒ ambient (no credential injection). */
  authDescriptor?: AdapterAuthDescriptor
  /** Adapter's default model id (`models.default`) — lets the resolver derive
   *  a provider for a by-model spawn that omitted `model`. */
  defaultModel?: string
} | null>

/**
 * UI-safe projection of an AIP-45 `modes[]` entry as surfaced by
 * `adapter_list`. Mirrors `@agentproto/cli`'s `AdapterMode` without
 * importing it (the runtime deliberately carries no cli dep — see the
 * `AgentAdapterLister` note above). Spawn internals (`bin_args_*`, `env`)
 * are intentionally omitted; `status` is normalised to `"active"` by the
 * lister when the manifest omits it, so a declared mode is never
 * silently statusless.
 */
export interface AdapterListMode {
  id: string
  description?: string
  status: "active" | "noop" | "planned"
  status_note?: string
}

/**
 * Compact adapter metadata for the discovery endpoints. Independent
 * of the resolver function above — hosts that can list installed
 * adapters wire this; hosts that can only resolve by-slug skip it
 * (the routes 501).
 */
export interface AdapterListEntry {
  slug: string
  name: string
  version: string
  description: string
  protocol: string
  streaming: boolean
  packageName: string
  /** Declared operation modes with their honest support status, so a
   *  client can see e.g. hermes' `lean` mode is a measured no-op instead
   *  of being silently accepted. Empty when the adapter declares none. */
  modes: AdapterListMode[]
}

export type AgentAdapterLister = () => Promise<AdapterListEntry[]>

export interface AuthOptions {
  mode: "none" | "bearer"
  token?: string
}

/**
 * Auth can be a fixed value (set at startup) or a getter (re-read on
 * every request). The getter form lets `remote_enable` flip bearer on
 * at runtime without restarting the gateway.
 */
export type AuthSource = AuthOptions | (() => AuthOptions)

export interface RuntimeHttpServerOptions {
  port: number
  bind?: string
  auth?: AuthSource
  /**
   * Per-request McpServer factory.
   *
   * The SDK's `StreamableHTTPServerTransport` is single-use — once a
   * transport has handled one request, the underlying `Protocol`
   * cannot be reattached, so subsequent requests on a shared transport
   * 500. The official stateless pattern (see SDK
   * `examples/server/simpleStatelessStreamableHttp.js`) builds a
   * fresh `McpServer` and `StreamableHTTPServerTransport` per request,
   * connects them, and tears both down on `res.close`. We follow that.
   *
   * The factory is invoked once per `/mcp` POST. It must register
   * tools / resources / prompts on the returned server before
   * resolving — by the time the transport's `handleRequest` fires,
   * the server is locked in.
   *
   * `denyTools`, when non-empty, is parsed from the request's
   * `?denyTools=a,b` query string (see `handleMcp` below) and is the
   * spawn-role-profiles tool gate for THIS surface: the hermes-default
   * `mcpServers` entry injected for an executor-role child (see
   * `session-spawn.ts`) carries this query param so the resulting
   * server excludes `agent_start`/`agent_prompt` while keeping every
   * other tool (fs, command_execute, …) — unlike the orchestrator's
   * curated allowlist, this surface can't just narrow to a small
   * subset without breaking the child's ability to do real work.
   */
  mcpServerFactory: (denyTools?: ReadonlySet<string>) => Promise<McpServer>
  /**
   * Optional scoped orchestrator sub-gateway (WP2). When BOTH this and
   * `verifyOrchestratorScope` are wired, the server mounts a second MCP
   * endpoint at `/mcp/orchestrator` that — unlike `/mcp` — has NO
   * loopback auth bypass: every request must present a valid scope-token
   * (`?scope=<token>` query or `X-Orchestrator-Scope` header). The token
   * resolves to a scope, and the factory builds a server exposing only
   * that scope's curated tool subset. This is what makes it safe to
   * point a child agent at the daemon (WP3 auto-injects the URL).
   */
  orchestratorMcpServerFactory?: OrchestratorMcpServerFactory
  /** Resolve a presented scope-token to its scope, or null when
   *  unknown/missing. Paired with `orchestratorMcpServerFactory`. */
  verifyOrchestratorScope?: (
    token: string | null | undefined,
  ) => OrchestratorScope | null
  conversations: ConversationStore
  events: RuntimeEvents
  heartbeat: HeartbeatRunner
  /** Optional — when wired, exposes /sessions routes for the CLI
   *  TUI and the guilde-web Active tab to navigate live child
   *  processes. Daemons that don't spawn anything (pure MCP servers)
   *  can omit this and the routes 404. */
  sessions?: SessionsRegistry
  /** Optional — when wired alongside `sessions`, enables
   *  `POST /sessions/agent` and `POST /sessions/:id/prompt` routes.
   *  Hosts that ship adapters (`agentproto serve`, playground)
   *  pass the cli's `resolveAdapter` via a thin shim. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional — mirrors `RegisterAgentToolsOptions.buildOrchestratorMcp`
   *  (agent-tools.ts). When wired, `POST /sessions/agent`'s
   *  `orchestrator` field mints a scoped sub-gateway token the same way
   *  the MCP `agent_start` tool does. Omitted → `orchestrator` on the
   *  HTTP route is rejected with a 501. */
  buildOrchestratorMcp?: BuildOrchestratorMcp
  /** Optional — mirrors `RegisterAgentToolsOptions.daemonMcpUrl`. When
   *  wired, a `POST /sessions/agent` spawn for a `hermes` adapter with
   *  no caller-supplied `mcpServers` defaults to mounting this gateway
   *  (same hermes safety net as the MCP tool). */
  daemonMcpUrl?: string
  /** Optional — when wired, enables `GET /adapters` route + the
   *  MCP `adapter_list` tool so UIs can discover what's installed
   *  without trial-and-error against the resolver. Hosts ship the
   *  cli's `listInstalledAdapters` via a thin shim. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional — when wired alongside `sessions`, enables
   *  `POST /sessions/browser` (same operation as MCP `start_browser`,
   *  exposed as an HTTP route for the CLI surface). */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Optional — passed to error messages on `POST /sessions/browser`
   *  to list available adapter ids when the requested one isn't found. */
  listBrowserAdapters?: BrowserAdapterLister
  /** Optional — MCP proxy registry. When wired, exposes
   *  `/mcps/proxy/*` routes that let the browser drive imported MCPs
   *  without going through the MCP wire protocol (useful for the
   *  /providers/mcp page's "Local" tab). */
  mcpProxy?: McpProxyRegistry
  /** Per-boot bearer token. When set, mutating /sessions/* routes
   *  + the /sessions/:id/pty WebSocket upgrade require either
   *  `Authorization: Bearer <token>` or an `Origin` header that
   *  matches `allowedOrigins`. Read-only routes (GET, SSE stream)
   *  stay open since the CORS surface already restricts origins
   *  enough for them. */
  token?: string
  /** Trusted browser origins. When a mutating request carries an
   *  `Origin: <url>` header (browser-set, JS can't forge), and that
   *  url is in this list, the request is allowed without a Bearer
   *  token. Browsers can't read the daemon's runtime.json (mode 0600)
   *  so they can't send the token — Origin-based auth lets a trusted
   *  page (Guilde web UI, local dev) drive the daemon. Non-browser
   *  callers (curl, the CLI) still use the token.
   *
   *  Match policy: exact origin (`https://guilde.work`) OR prefix
   *  with `:*` for any-port match (`http://localhost:*` matches
   *  `http://localhost:3000`).
   *
   *  Default (when undefined): localhost on any port is allowed via
   *  `DEFAULT_ALLOWED_ORIGINS`. Production origins are opt-in via
   *  `agentproto serve --allow-origin <url>`. Pair with `strictOrigins`
   *  to remove the localhost defaults entirely. */
  allowedOrigins?: readonly string[]
  /** When true, skip the localhost-wildcard defaults — only the
   *  explicit `allowedOrigins` list is honoured. Useful for daemons
   *  on shared hosts or when the user wants to lock dev to a
   *  specific port. Default false (current behaviour — any browser
   *  on `localhost` is trusted). */
  strictOrigins?: boolean
  /** Whether `POST /sessions/terminal` + WS upgrade are advertised.
   *  Reflects whether the host injected a PTY factory into the
   *  SessionsRegistry. When false, the terminal HTTP route returns
   *  501 and the WS upgrade rejects. */
  ptyEnabled?: boolean
  /** Optional — when wired, exposes /tunnels/* routes for creating and
   *  managing public tunnels for local ports. Without it the routes 404. */
  tunnels?: TunnelRegistry
  /** Optional — when wired, exposes /pairings/* routes for minting offers,
   *  listing pairings, and revoking them (E2E daemon pairing). Same service the
   *  MCP `pair_offer` / `pair_list` / `pair_revoke` tools call. Without it the
   *  routes 404. */
  pairings?: PairingRegistry
  /** Optional — the session lifecycle event bus. When wired alongside
   *  `sessions`, `eventRing`, enables `GET /sessions/:id/wait` (a blocking
   *  long-poll that resolves when the session fires a lifecycle event).
   *  Same machinery the MCP `session_monitor` tool uses. */
  sessionEvents?: SessionEventBus
  /** Optional — the cursor ring buffer over `sessionEvents`. Paired with
   *  `sessionEvents` to enable `GET /sessions/:id/wait` (cursor-based
   *  race-free replay via the `since` query param). */
  eventRing?: EventRing
  /** Optional — the completion-policy supervisor. When wired, enables
   *  `GET /policies/:id/wait` (a blocking long-poll that resolves when the
   *  policy leaves watching/gating → done/blocked/awaiting-ack/cancelled).
   *  Same state the MCP `policy_status` tool reports. */
  supervisor?: CompletionPolicySupervisor
  /** Optional — when wired, exposes /cron routes for creating and
   *  managing durable cron jobs. Without it the routes 404. */
  cronScheduler?: import("./cron-scheduler.js").CronScheduler
  /** Optional — when wired, exposes /routines/* routes for starting and
   *  managing background routine runs (sequential steps with per-step
   *  fan-in). Same service the MCP `routine_start/status/cancel/
   *  escalation_resolve/list` tools call. Without it the routes 404. */
  routineRunner?: RoutineRunner
  /** Optional — when wired, exposes /workflows/* routes for starting and
   *  managing background workflow runs (stage-barrier parallel steps).
   *  Same service the MCP `workflow_start/status/cancel/
   *  escalation_resolve/list` tools call. Without it the routes 404. */
  workflowRunner?: WorkflowRunner
  /** Static fields surfaced via `/health`. */
  meta: {
    workspace: string
    registered: readonly string[]
    /** Daemon start timestamp. Defaults to `Date.now()` at server start. */
    startedAt?: number
  }
}

export interface RuntimeHttpServerHandle {
  url: string
  stop(): Promise<void>
}

export async function startHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const startedAt = opts.meta.startedAt ?? Date.now()
  const authSource: AuthSource = opts.auth ?? { mode: "none" }
  const readAuth = (): AuthOptions =>
    typeof authSource === "function" ? authSource() : authSource

  /**
   * Loopback bypass — requests originating from 127.0.0.1 / ::1 with
   * no `X-Forwarded-For` header skip the bearer check even when one is
   * configured. Rationale:
   *
   *   1. The bearer is meant to gate the *public tunnel*, not the
   *      loopback socket. Without this, calling `remote_enable` from a
   *      local MCP client immediately 401s that same local client —
   *      the user locks themselves out and the only recovery is a
   *      gateway restart. Hit this in real use; not a theoretical edge.
   *
   *   2. Cloudflared (and any reasonable tunnel) sets X-Forwarded-For
   *      when forwarding a public request to the loopback origin. So
   *      "loopback AND no XFF" is a tight characterisation of "this
   *      request never left the machine."
   *
   *   3. Local FS access already trumps bearer (the user can read
   *      runtime.json, kill -9 the daemon, etc.). Adding another check
   *      here doesn't raise the bar for someone with shell on the box.
   *
   * If your threat model is "untrusted users on the same loopback
   * interface" (unusual — usually a multi-tenant container scenario),
   * pass `auth: { mode: "bearer", … }` at startup instead of relying
   * on the controller's runtime flip; the auth getter will return the
   * stricter of the two and the bypass still applies (intentional —
   * the operator opted in to bearer with full knowledge of the trade).
   */
  function isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? ""
    const isLocalAddr =
      addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
    if (!isLocalAddr) return false
    // X-Forwarded-For present ⇒ a tunnel is in front of us; the
    // request crossed the public internet to reach this socket.
    if (req.headers["x-forwarded-for"]) return false
    return true
  }

  function authorize(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = readAuth()
    if (auth.mode === "none") return true
    if (isLoopback(req)) return true
    const header = req.headers.authorization
    const expected = `Bearer ${auth.token}`
    if (header !== expected) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return false
    }
    return true
  }

  /**
   * Per-boot auth gate for mutating /sessions/* routes and the WS
   * upgrade for /sessions/:id/pty. Accepts EITHER:
   *
   *   1. `Authorization: Bearer <token>` matching the per-boot token
   *      (the CLI path — reads runtime.json mode 0600).
   *   2. A WS-upgrade query-string `?token=<token>` (browser
   *      WebSocket can't set headers; some non-browser clients use
   *      this too).
   *   3. An `Origin: <url>` header matching `allowedOrigins` — the
   *      browser path. Origin is browser-set, JS can't forge.
   *
   * UNLIKE `authorize()`, this does NOT have a loopback bypass: the
   * threat we're defending against (browser drive-by spawning shells
   * via fetch to 127.0.0.1) IS loopback. Browsers can't read
   * runtime.json (mode 0600); a same-origin trusted page can rely on
   * its Origin instead.
   *
   * When `opts.token` is unset (older host integrations), this is a
   * no-op so existing call sites keep working.
   */
  function checkSessionsToken(req: IncomingMessage): "ok" | "missing" | "bad" {
    if (!opts.token) return "ok"

    // 1. Header bearer token.
    const header = req.headers.authorization
    const expected = `Bearer ${opts.token}`
    if (header === expected) return "ok"

    // 2. ?token=<token> in the URL (WS upgrade convenience).
    const urlStr = req.url ?? ""
    if (urlStr.includes("?")) {
      const qs = new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1))
      const qsToken = qs.get("token")
      if (qsToken && qsToken === opts.token) return "ok"
    }

    // 3. Origin allowlist (browser path).
    const origin = req.headers.origin
    if (typeof origin === "string" && originAllowed(origin)) return "ok"

    return header ? "bad" : "missing"
  }

  function originAllowed(origin: string): boolean {
    // Defaults are normally in effect — `opts.allowedOrigins` extends
    // them rather than replacing. Otherwise setting one production
    // origin via config silently locks out `http://localhost:*`,
    // breaking local dev. Users who genuinely want a curated list
    // (shared host, paranoid local-only ports) set `strictOrigins:true`
    // which drops the defaults entirely.
    const list = opts.strictOrigins
      ? (opts.allowedOrigins ?? [])
      : [...DEFAULT_ALLOWED_ORIGINS, ...(opts.allowedOrigins ?? [])]
    for (const pattern of list) {
      if (pattern === origin) return true
      // `http://localhost:*` style: match the host prefix, any port.
      if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -2) // drop ":*"
        if (origin === prefix || origin.startsWith(prefix + ":")) return true
      }
    }
    return false
  }

  function rejectUnauthorizedSession(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "missing" | "bad",
  ): void {
    const origin = req.headers.origin ?? null
    const allowList = opts.strictOrigins
      ? (opts.allowedOrigins ?? [])
      : [...DEFAULT_ALLOWED_ORIGINS, ...(opts.allowedOrigins ?? [])]
    res.writeHead(401, { "content-type": "application/json" })
    const message =
      kind === "missing"
        ? origin
          ? `Origin "${origin}" not in the daemon's allowlist, and no Bearer token sent. ` +
            `Either add it (\`agentproto config set daemon.allowedOrigins ${origin}\` then restart the daemon), ` +
            `or send Authorization: Bearer <token> read from <workspace>/.agentproto/runtime.json.`
          : `Authorization: Bearer <token> required on mutating /sessions/* routes. ` +
            `Read the token from <workspace>/.agentproto/runtime.json. ` +
            `(Browser callers can use an Origin in the allowlist instead.)`
        : `Invalid bearer token. The daemon regenerated its token on its last boot — ` +
          `re-read <workspace>/.agentproto/runtime.json.`
    res.end(
      JSON.stringify({
        error: "sessions_unauthorized",
        message,
        // Debug data so a UI / network-tab inspection points the user
        // straight at the fix without needing the daemon's stderr.
        rejectedOrigin: origin,
        allowedOrigins: allowList,
        // We never echo the token; only the absence-or-presence flag.
        receivedAuthHeader: typeof req.headers.authorization === "string",
      }),
    )
  }

  /**
   * Returns true when this `path` + `method` is a mutating /sessions/*
   * route that should require the per-boot token. Kept narrow: GETs
   * (list, get, SSE stream) stay open for read-only telemetry from
   * existing tools that haven't learned about the token yet.
   */
  function isMutatingSessionsRoute(method: string, path: string): boolean {
    if (!path.startsWith("/sessions")) return false
    if (method === "POST" || method === "DELETE" || method === "PUT" || method === "PATCH") {
      return true
    }
    return false
  }

  /**
   * Drive one MCP request over a fresh server+transport pair, per the
   * SDK's stateless pattern. Sharing either across requests breaks after
   * the first one because `Protocol.connect` rejects re-attachment.
   * Shared by `/mcp` and the scoped `/mcp/orchestrator` endpoint.
   */
  async function serveMcp(
    req: IncomingMessage,
    res: ServerResponse,
    server: McpServer,
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    // `onerror` is an unofficial SDK hook — guard before assigning so
    // a future SDK rename doesn't silently drop transport error logs.
    const transportInternal = transport as unknown as Record<string, unknown>
    if ("onerror" in (transport as object)) {
      transportInternal["onerror"] = (err: unknown) => {
        console.error("[mcp transport.onerror]", err)
      }
    }

    res.on("close", () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error("[mcp] handleRequest threw:", err)
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "mcp_transport_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
  }

  function parseDenyToolsQuery(url: string): Set<string> | undefined {
    const qIdx = url.indexOf("?")
    if (qIdx === -1) return undefined
    const raw = new URLSearchParams(url.slice(qIdx + 1)).get("denyTools")
    if (!raw) return undefined
    const names = raw.split(",").map(s => s.trim()).filter(Boolean)
    return names.length > 0 ? new Set(names) : undefined
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req, res)) return
    const denyTools = parseDenyToolsQuery(req.url ?? "")
    const server = await opts.mcpServerFactory(denyTools)
    await serveMcp(req, res, server)
  }

  /**
   * Scoped orchestrator sub-gateway (WP2). Mounted at
   * `/mcp/orchestrator`. CRITICALLY this does NOT call `authorize()`:
   * the loopback bypass that makes `/mcp` open to any local process is
   * exactly what we must not inherit here — a child gets the
   * orchestration subset ONLY by presenting a valid scope-token. The
   * token arrives via `?scope=<token>` (the injected URL form) or the
   * `X-Orchestrator-Scope` header.
   */
  async function handleOrchestratorMcp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!opts.orchestratorMcpServerFactory || !opts.verifyOrchestratorScope) {
      res.writeHead(501, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "orchestrator_gateway_not_configured",
          message:
            "The daemon was started without the scoped orchestrator " +
            "sub-gateway. Wire `orchestratorMcpServerFactory` + " +
            "`verifyOrchestratorScope` in createGateway.",
        }),
      )
      return
    }
    const urlStr = req.url ?? ""
    let token: string | null = null
    if (urlStr.includes("?")) {
      token = new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1)).get(
        "scope",
      )
    }
    if (!token) {
      const headerTok = req.headers["x-orchestrator-scope"]
      if (typeof headerTok === "string") token = headerTok
    }
    const scope = opts.verifyOrchestratorScope(token)
    if (!scope) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "orchestrator_scope_required",
          message:
            "A valid scope-token is required on /mcp/orchestrator " +
            "(pass `?scope=<token>` or the `X-Orchestrator-Scope` header). " +
            "Unlike /mcp, this endpoint has no loopback bypass.",
        }),
      )
      return
    }
    const server = await opts.orchestratorMcpServerFactory(scope)
    await serveMcp(req, res, server)
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        status: "ok",
        workspace: opts.meta.workspace,
        registered: opts.meta.registered,
        uptimeMs: Date.now() - startedAt,
      }),
    )
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    if (!authorize(req, res)) return
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    res.write(`: connected\n\n`)
    const off = opts.events.onAny((ev: RuntimeEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    })
    req.on("close", off)
  }

  async function handleListConversations(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!authorize(req, res)) return
    const list = await opts.conversations.list()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(list))
  }

  async function handleGetConversation(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    if (!authorize(req, res)) return
    try {
      const data = await opts.conversations.read(id)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(data))
    } catch (err) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "not_found",
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  async function handleHeartbeatTick(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!authorize(req, res)) return
    await opts.heartbeat.fireNow()
    res.writeHead(202, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "fired" }))
  }

  /**
   * POST /files/upload?cwd=<abs-dir>&name=<filename>
   *
   * Writes the raw request body bytes to
   * `{cwd}/.agentproto-attachments/{safe-name}`, creating the
   * subdirectory on demand, and returns `{path}` with the absolute
   * path the agent CLI can read. Used by the host UI's terminal
   * drag-drop: the browser can't read the dragged file's source path
   * (security), so we copy the bytes to a known location and tell the
   * UI to paste THAT path into the terminal — claude-code (and any
   * CLI with a Read tool) picks it up natively.
   *
   * Gated by `checkSessionsToken` so a drive-by HTTP request can't
   * write arbitrary files: only sessions-authorized callers (CLI or
   * an allow-listed browser origin) can hit it.
   *
   * Hardening:
   *   - `cwd` must be absolute and exist as a directory.
   *   - `name` is basename-sanitized (no `/`, `..`, NULs).
   *   - The resolved write target must stay within
   *     `{cwd}/.agentproto-attachments/` (defense-in-depth in case the
   *     name sanitizer ever drifts).
   *   - Body capped at 32 MiB. Larger uploads error 413 instead of
   *     filling the daemon's disk.
   */
  async function handleFileUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "")
    const cwd = qs.get("cwd")
    const rawName = qs.get("name")
    if (!cwd || !rawName) {
      reply(400, { error: "missing_cwd_or_name" })
      return
    }
    if (!isAbsolute(cwd)) {
      reply(400, { error: "cwd_not_absolute" })
      return
    }
    // basename-style sanitize: strip path separators + parent refs +
    // NUL bytes; collapse leading dots so the file is visible. The
    // resolvePath check below catches anything this misses.
    const safeName = rawName
      .replace(/[\x00/\\]/g, "_")
      .replace(/\.\.+/g, ".")
      .replace(/^\.+/, "")
      .slice(0, 200)
    if (safeName.length === 0) {
      reply(400, { error: "invalid_name" })
      return
    }
    try {
      const st = await stat(cwd)
      if (!st.isDirectory()) {
        reply(400, { error: "cwd_not_a_directory" })
        return
      }
    } catch {
      reply(400, { error: "cwd_not_found" })
      return
    }
    const dir = join(cwd, ".agentproto-attachments")
    const target = resolvePath(dir, safeName)
    // Defense-in-depth: the sanitized name should never escape `dir`,
    // but if the sanitizer ever drifts, this catches the escape.
    if (!target.startsWith(resolvePath(dir) + (dir.endsWith("/") ? "" : "/"))) {
      reply(400, { error: "path_traversal_blocked" })
      return
    }
    const MAX_BYTES = 32 * 1024 * 1024 // 32 MiB
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    await new Promise<void>((resolveBody, rejectBody) => {
      req.on("data", chunk => {
        if (aborted) return
        const buf = chunk as Buffer
        total += buf.length
        if (total > MAX_BYTES) {
          aborted = true
          reply(413, { error: "file_too_large", maxBytes: MAX_BYTES })
          rejectBody(new Error("too_large"))
          return
        }
        chunks.push(buf)
      })
      req.on("end", () => {
        if (!aborted) resolveBody()
      })
      req.on("error", err => rejectBody(err))
    }).catch(() => undefined)
    if (aborted) return
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(target, Buffer.concat(chunks))
      reply(200, { path: target, bytes: total })
    } catch (err) {
      reply(500, {
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Permissive CORS for the loopback gateway. The Guilde web app
  // (localhost:3041) probes /health from the browser; without these
  // headers the browser blocks the response and the panel says
  // "not reachable" even though curl works. Auth still gates the
  // sensitive routes — this just lifts the cross-origin block.
  //
  // Private Network Access (Chrome 105+): when an HTTPS page like
  // https://guilde.work fetches a loopback URL, Chrome sends a
  // preflight with `Access-Control-Request-Private-Network: true`.
  // Without `Access-Control-Allow-Private-Network: true` in the
  // response, the browser blocks the actual GET. Mirror the flag
  // when the request asked for it.
  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = (req.headers.origin as string | undefined) ?? "*"
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ??
        "authorization,content-type,mcp-session-id",
    )
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    )
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true")
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/"
        const path = url.split("?")[0] ?? "/"
        // Diagnostic: emit forwarded requests (those carrying XFF) onto
        // the events stream so /events tailers can see what cloudflared
        // actually sends. Loopback-only traffic stays quiet to avoid
        // flooding subscribers during normal local use.
        if (req.headers["x-forwarded-for"]) {
          opts.events.emit({
            type: "remote-log",
            at: new Date().toISOString(),
            line: `[http-in] ${req.method} ${url} host=${req.headers.host ?? "?"} xff=${String(req.headers["x-forwarded-for"])}`,
          })
        }

        applyCors(req, res)
        if (req.method === "OPTIONS") {
          res.writeHead(204)
          res.end()
          return
        }

        if (path === "/health" && req.method === "GET") {
          handleHealth(req, res)
          return
        }
        if (path === "/events" && req.method === "GET") {
          handleEvents(req, res)
          return
        }
        if (path === "/mcp/orchestrator") {
          await handleOrchestratorMcp(req, res)
          return
        }
        if (path === "/mcp") {
          await handleMcp(req, res)
          return
        }
        if (path === "/conversations" && req.method === "GET") {
          await handleListConversations(req, res)
          return
        }
        if (path.startsWith("/conversations/") && req.method === "GET") {
          const id = path.slice("/conversations/".length)
          await handleGetConversation(req, res, id)
          return
        }
        if (path === "/heartbeat/tick" && req.method === "POST") {
          await handleHeartbeatTick(req, res)
          return
        }

        if (path === "/files/upload" && req.method === "POST") {
          // Same auth gate as the mutating /sessions/* routes — drive-by
          // HTTP shouldn't be able to write arbitrary files to disk.
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          await handleFileUpload(req, res, url)
          return
        }

        // Sessions routes — only registered when the gateway was
        // built with a SessionsRegistry. /sessions, /sessions/:id,
        // /sessions/:id/stream (SSE), POST /sessions/:id/kill,
        // DELETE /sessions/:id (forget after exit).
        if (opts.sessions && path.startsWith("/sessions")) {
          if (isMutatingSessionsRoute(req.method ?? "GET", path)) {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handleSessions(
            req,
            res,
            path,
            opts.sessions,
            opts.resolveAgentAdapter,
            opts.ptyEnabled === true,
            opts.resolveBrowserAdapter,
            opts.listBrowserAdapters,
            opts.sessionEvents,
            opts.eventRing,
            opts.buildOrchestratorMcp,
            opts.daemonMcpUrl,
          )
          if (handled) return
        }

        if (path === "/workspaces" && req.method === "GET") {
          // Surface ~/.agentproto/workspaces.json for UIs that
          // want a workspace dropdown (spawn dialog, MCP discovery
          // grouping, etc.). Read-only; mutate via the CLI's
          // `agentproto workspace add/remove/use` verbs.
          try {
            const config = await loadWorkspacesConfig()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(config))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspaces_load_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        if (path === "/mcps/imports" && req.method === "GET") {
          const config = await loadImportedMcps()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(config))
          return
        }
        if (path === "/mcps/imports" && req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            sourceMcpId?: string
            alias?: string
          } | null
          if (!body || typeof body.sourceMcpId !== "string") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing_sourceMcpId" }))
            return
          }
          const discovered = await discoverMcps()
          const snapshot = discovered.find(d => d.id === body.sourceMcpId)
          if (!snapshot) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "discovered_mcp_not_found",
                sourceMcpId: body.sourceMcpId,
              })
            )
            return
          }
          const cfg = await loadImportedMcps()
          const next = addImport(cfg, {
            snapshot,
            ...(body.alias ? { alias: body.alias } : {}),
          })
          await saveImportedMcps(next)
          res.writeHead(201, { "content-type": "application/json" })
          res.end(JSON.stringify(next.imports.find(e => e.id === snapshot.id)))
          return
        }
        const importMatch = path.match(/^\/mcps\/imports\/(.+)$/)
        if (importMatch && req.method === "DELETE") {
          // The id is URL-encoded since it contains colons + slashes
          // (e.g. claude-code:project:/path:name).
          const id = decodeURIComponent(importMatch[1] ?? "")
          const cfg = await loadImportedMcps()
          if (!cfg.imports.some(e => e.id === id)) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "import_not_found", id }))
            return
          }
          await saveImportedMcps(removeImport(cfg, id))
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, id }))
          return
        }

        if (path === "/mcps/discovered" && req.method === "GET") {
          // No host wiring needed — the scanner reads
          // ~/.claude.json + ~/.cursor/mcp.json + goose config
          // directly. Always available; cheap (~5ms typical).
          try {
            const mcps = await discoverMcps()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ mcps }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "discovery_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Browser-friendly proxy surface — same operations the MCP
        // tools expose (mcp_imported_status / list_tools / call) but
        // over plain HTTP so the /providers/mcp page can render them
        // without embedding an MCP client.
        if (path === "/mcps/proxy/status" && req.method === "GET") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          try {
            const imports = await opts.mcpProxy.listAliases()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ imports }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "proxy_status_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }
        const proxyToolsMatch = path.match(/^\/mcps\/proxy\/tools\/(.+)$/)
        if (proxyToolsMatch && req.method === "GET") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          const alias = decodeURIComponent(proxyToolsMatch[1] ?? "")
          const out = await opts.mcpProxy.listTools(alias)
          res.writeHead(out.ok ? 200 : 502, {
            "content-type": "application/json",
          })
          res.end(JSON.stringify(out))
          return
        }
        if (path === "/mcps/proxy/call" && req.method === "POST") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          const body = (await readJsonBody(req)) as {
            alias?: unknown
            toolName?: unknown
            args?: unknown
          } | null
          if (
            !body ||
            typeof body.alias !== "string" ||
            typeof body.toolName !== "string"
          ) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "invalid_body",
                message: "expected { alias, toolName, args? }",
              })
            )
            return
          }
          const result = await opts.mcpProxy.callTool(
            body.alias,
            body.toolName,
            body.args ?? {}
          )
          res.writeHead(result.ok ? 200 : 502, {
            "content-type": "application/json",
          })
          res.end(JSON.stringify(result))
          return
        }

        if (path === "/adapters" && req.method === "GET") {
          if (!opts.listAgentAdapters) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "lister_not_configured",
                message:
                  "Daemon was started without `listAgentAdapters` — see " +
                  "@agentproto/cli's `listInstalledAdapters` for the canonical impl.",
              })
            )
            return
          }
          try {
            const adapters = await opts.listAgentAdapters()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ adapters }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "list_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Preset routes — static data, always available (no registry opt-in).
        // GET /presets → { presets: AdapterEntry<PresetInfo>[] }
        if (path === "/presets" && req.method === "GET") {
          const handled = await handlePresets(req, res, path)
          if (handled) return
        }

        // Tunnel routes — only registered when the gateway was built with
        // a TunnelRegistry. /tunnels, /tunnels/:id.
        if (opts.tunnels && path.startsWith("/tunnels")) {
          const handled = await handleTunnels(req, res, path, opts.tunnels)
          if (handled) return
        }

        // Routine routes — only registered when the gateway was built with
        // a RoutineRunner. /routines, /routines/:id, /routines/:id/cancel,
        // /routines/:id/escalation/resolve. Mirrors the MCP `routine_*`
        // tools (orchestration-tools.ts) — same RoutineRunner instance.
        if (
          opts.routineRunner &&
          (path === "/routines" || path.startsWith("/routines/"))
        ) {
          const handled = await handleRoutines(req, res, path, opts.routineRunner)
          if (handled) return
        }

        // Workflow routes — only registered when the gateway was built with
        // a WorkflowRunner. /workflows, /workflows/:id, /workflows/:id/cancel,
        // /workflows/:id/escalation/resolve. Mirrors the MCP `workflow_*`
        // tools (orchestration-tools.ts) — same WorkflowRunner instance.
        if (
          opts.workflowRunner &&
          (path === "/workflows" || path.startsWith("/workflows/"))
        ) {
          const handled = await handleWorkflows(req, res, path, opts.workflowRunner)
          if (handled) return
        }

        // Policy routes — POST /policies (attach), GET /policies (list),
        // POST /policies/:id/cancel, POST /policies/:id/ack, and the
        // blocking long-poll `GET /policies/:id/wait` (resolves when the
        // policy leaves watching/gating → done/blocked/awaiting-ack/
        // cancelled, or timeoutMs elapses). Mirrors the MCP `policy_attach/
        // status/cancel/ack/list` tools — same CompletionPolicySupervisor
        // instance. Only mounted when a supervisor is wired.
        if (
          opts.supervisor &&
          (path === "/policies" || path.startsWith("/policies/"))
        ) {
          const handled = await handlePolicies(
            req,
            res,
            path,
            opts.supervisor,
            opts.sessions,
          )
          if (handled) return
        }

        // Permission inbox routes — GET /permissions (list pending across all
        // permission-hold sessions), POST /permissions/:id (approve/deny).
        // Mirrors the MCP `permissions_list` / `permissions_respond` tools —
        // same SessionsRegistry inbox. Only mounted when a registry is wired.
        if (opts.sessions && path.startsWith("/permissions")) {
          // Non-GET (approve/deny) is a mutating action — same per-boot token
          // gate as the mutating /sessions/* routes. GET is read-only, ungated.
          if ((req.method ?? "GET") !== "GET") {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handlePermissions(req, res, path, opts.sessions)
          if (handled) return
        }

        // Pairing routes — E2E daemon pairing. POST /pairings/offer,
        // GET /pairings, DELETE /pairings/:fingerprint. All mutating routes
        // (and the offer route, which starts an outbound rendezvous dial) take
        // the per-boot token gate; GET is read-only. Only mounted when a
        // registry is wired.
        if (opts.pairings && path.startsWith("/pairings")) {
          if ((req.method ?? "GET") !== "GET") {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handlePairings(req, res, path, opts.pairings)
          if (handled) return
        }

        // Cron routes — only registered when the gateway was built with
        // a CronScheduler. /cron, /cron/:id, /cron/:id/run.
        if (opts.cronScheduler && path.startsWith("/cron")) {
          const handled = await handleCron(req, res, path, opts.cronScheduler)
          if (handled) return
        }

        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not_found", path }))
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: "internal_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
    })()
  })

  // ── WebSocket upgrade: /sessions/:id/pty ──
  // Single WSS bound to the HTTP server's `upgrade` event. Connections
  // are accepted only when the SessionsRegistry is wired AND PTY
  // support is advertised. Frames are JSON-encoded over text WS
  // messages (binary mode is a future optimization — JSON keeps
  // wireshark/devtools debuggable):
  //   server → client: {kind:"data", b64:"..."}
  //   server → client: {kind:"exit", exitCode:0, signal?:1}
  //   client → server: {kind:"input", b64:"..."}  (or {kind:"input", text:"..."})
  //   client → server: {kind:"resize", cols:80, rows:24}
  //   client → server: {kind:"ping"}              (no-op keepalive)
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/"
    const path = url.split("?")[0] ?? "/"
    const ptyMatch = path.match(/^\/sessions\/([^/]+)\/pty$/)
    if (!ptyMatch) {
      socket.destroy()
      return
    }
    if (!opts.sessions || opts.ptyEnabled !== true) {
      rejectUpgrade(socket, 501, "pty_not_configured")
      return
    }
    // Per-boot token gate, no loopback bypass — see comment on
    // checkSessionsToken for why.
    const gate = checkSessionsToken(req)
    if (gate !== "ok") {
      rejectUpgrade(socket, 401, gate === "missing" ? "missing_token" : "bad_token")
      return
    }
    const id = ptyMatch[1]
    if (!id) {
      rejectUpgrade(socket, 400, "missing_id")
      return
    }
    // Resolve id-or-name BEFORE upgrading so a typo returns a clean
    // 404 instead of a successful WS that immediately closes.
    const desc = opts.sessions.findByIdOrName(id)
    if (!desc) {
      rejectUpgrade(socket, 404, "session_not_found")
      return
    }
    if (desc.pty !== true) {
      rejectUpgrade(socket, 400, "session_not_pty")
      return
    }
    // A descriptor for an exited/killed/error session lives on as
    // history — its PTY child is gone. Reject the upgrade with a
    // clear reason so the CLI/web client can suggest `restart`
    // instead of letting the user see a generic 1011 mid-attach.
    if (
      desc.status === "exited" ||
      desc.status === "killed" ||
      desc.status === "error"
    ) {
      rejectUpgrade(
        socket,
        410,
        `session_${desc.status}`,
        `Session ${desc.id}${desc.name ? ` (${desc.name})` : ""} has ${desc.status}. ` +
          `Spawn a fresh one with: agentproto sessions restart ${desc.name ?? desc.id}`,
      )
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      handlePtyWebSocket(ws, req, desc.id, opts.sessions!)
    })
  })

  const bind = opts.bind ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, bind, () => resolve())
  })

  return {
    url: `http://${bind}:${opts.port}`,
    async stop() {
      // Per-request transports/servers are torn down on `res.close`,
      // so we only need to stop the HTTP listener here. The WSS is
      // bound `noServer:true` so closing the HTTP server also tears
      // down its underlying TCP socket; live WS connections receive
      // a close frame from the kernel.
      wss.close()
      // `server.close()`'s callback only fires once every existing
      // connection has ended on its own — it does NOT sever them.
      // This daemon's whole purpose is long-lived keep-alive/SSE
      // connections (session_monitor long-polls, output streaming,
      // WS PTYs), so under normal load at least one is always open
      // and `close()` would hang forever, leaving SIGTERM/SIGINT
      // looking "ignored". `closeAllConnections()` (Node 18.2+)
      // forcibly destroys every open socket so shutdown actually
      // completes.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Reject an HTTP upgrade attempt with a structured plaintext body.
 * `ws.handleUpgrade` is meant to be the success path — if we can't
 * accept the upgrade we write a minimal HTTP response and destroy
 * the socket, matching ws's own internal error path.
 */
function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
  message?: string,
): void {
  const reasonText = `${status} ${reason}`
  const body: { error: string; message?: string } = { error: reason }
  if (message) body.message = message
  try {
    socket.write(
      `HTTP/1.1 ${reasonText}\r\n` +
        `Content-Type: application/json\r\n` +
        `Connection: close\r\n\r\n` +
        JSON.stringify(body) +
        `\n`,
    )
  } catch {
    // socket already gone — fall through
  }
  socket.destroy()
}

/**
 * Per-connection WS handler for /sessions/:id/pty. Attaches as a
 * subscriber to the SessionsRegistry; bridges JSON frames in both
 * directions. Per-subscriber backpressure: if the WS's `bufferedAmount`
 * exceeds a threshold, the next chunk is dropped (slow client must
 * not stall the daemon's fan-out to other subscribers).
 */
function handlePtyWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  sessionId: string,
  registry: SessionsRegistry,
): void {
  // Parse cols/rows from the query string for the initial dimension
  // hint. Real clients will send a {kind:"resize"} immediately after
  // connecting; this seeds the registry's min-size calculation so the
  // first replay frames render at a sensible width if no resize comes.
  const query = new URLSearchParams(
    (req.url ?? "").includes("?") ? (req.url ?? "").split("?")[1] : "",
  )
  const cols = clampPositiveInt(query.get("cols"), 80)
  const rows = clampPositiveInt(query.get("rows"), 24)

  // Backpressure threshold — when the socket has more than 256 KiB
  // queued, drop the next data frame for THIS subscriber rather than
  // letting the registry block on send. Other subscribers stay live.
  const BACKPRESSURE_BYTES = 256 * 1024

  const handle = registry.attachPty(
    sessionId,
    { cols, rows },
    chunk => {
      if (ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) return // drop
      ws.send(
        JSON.stringify({ kind: "data", b64: chunk.toString("base64") }),
      )
    },
    evt => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(
        JSON.stringify({
          kind: "exit",
          exitCode: evt.exitCode,
          ...(evt.signal != null ? { signal: evt.signal } : {}),
        }),
      )
      // Close ourselves once we've emitted exit — the session can be
      // reattached for a buffer replay but this socket is done.
      try {
        ws.close(1000, "session exited")
      } catch {
        // ignore
      }
    },
  )

  if (!handle) {
    // Race: the session may have vanished between the upgrade and
    // attach. Close politely.
    try {
      ws.close(1011, "session not attachable")
    } catch {
      // ignore
    }
    return
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // Binary frames not supported yet — wire format is JSON-only.
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(raw.toString("utf8"))
    } catch {
      return // malformed
    }
    if (!frame || typeof frame !== "object") return
    const f = frame as Record<string, unknown>
    switch (f.kind) {
      case "input": {
        // Accept either {text} (UTF-8) or {b64} (arbitrary bytes,
        // useful for clients sending raw key sequences).
        if (typeof f.text === "string") {
          handle.write(f.text)
        } else if (typeof f.b64 === "string") {
          try {
            handle.write(Buffer.from(f.b64, "base64").toString("utf8"))
          } catch {
            // ignore malformed base64
          }
        }
        break
      }
      case "resize": {
        const c =
          typeof f.cols === "number" && f.cols > 0 ? Math.floor(f.cols) : null
        const r =
          typeof f.rows === "number" && f.rows > 0 ? Math.floor(f.rows) : null
        if (c && r) handle.resize(c, r)
        break
      }
      case "ping":
        // Reply with pong so client keepalive logic works. Optional.
        try {
          ws.send(JSON.stringify({ kind: "pong" }))
        } catch {
          // ignore
        }
        break
      // Unknown kinds silently dropped; reserved for forward compat.
    }
  })

  ws.on("close", () => {
    handle.detach()
  })
  ws.on("error", () => {
    handle.detach()
  })
}

function clampPositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * /sessions routes — split out of the main switch so the surface
 * stays scannable. Returns `true` when it handled the request, so
 * the dispatcher knows to skip the 404 path.
 *
 *   GET    /sessions              → list of SessionDescriptor[]
 *   GET    /sessions/:id          → one SessionDescriptor
 *   GET    /sessions/:id/stream   → SSE stream {line,stream} events
 *   GET    /sessions/:id/export   → ExportAgentSessionResult (transcript as markdown or JSON)
 *   GET    /sessions/:id/events   → raw structured events.jsonl records for a session.
 *                                    Query: since=<seq> (default 0), limit=<n> (default 500,
 *                                    max 2000). Returns {sessionId, events, nextSeq, complete};
 *                                    404 {error:"no_transcript"} when the file doesn't exist.
 *                                    Read-only GET, no auth gate (same policy as /export).
 *   GET    /sessions/:id/wait     → block until a lifecycle event fires (long-poll;
 *                                    requires sessionEvents + eventRing wired). Query:
 *                                    event=turn-end|awaiting-input|exited|any (default any),
 *                                    since=<cursor>, timeoutMs=<n> (default 25000, cap 55000).
 *   POST   /sessions/:id/kill     → SIGTERM, returns {ok}
 *   DELETE /sessions/:id          → forget (drop from registry; only
 *                                    valid for exited/killed/error)
 *   POST   /sessions/browser      → start a browser adapter and register
 *                                    as a tracked session; body:
 *                                    { adapter, port?, camofoxPort?, label?,
 *                                      location?, baseUrl?, binPath? }
 *                                    (requires `resolveBrowserAdapter` wired)
 */
/** Parse the `orchestrator` body field on `POST /sessions/agent` — the
 *  same flexible `boolean | object` shape the MCP `agent_start` tool's
 *  `jsonTolerant` schema accepts, including a JSON-stringified form of
 *  either (some HTTP clients serialize nested fields as strings the
 *  same way the MCP-over-stdio clients that motivated `jsonTolerant`
 *  do). Malformed values are dropped (undefined) rather than 400'd —
 *  matches this route's existing lenient body-field parsing. */
function parseOrchestratorField(
  raw: unknown,
): boolean | { tools?: string[]; maxDepth?: number; maxChildren?: number } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (typeof value === "boolean") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const tools = Array.isArray(obj.tools)
      ? obj.tools.filter((t): t is string => typeof t === "string")
      : undefined
    const maxDepth = typeof obj.maxDepth === "number" ? obj.maxDepth : undefined
    const maxChildren = typeof obj.maxChildren === "number" ? obj.maxChildren : undefined
    return {
      ...(tools ? { tools } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxChildren !== undefined ? { maxChildren } : {}),
    }
  }
  return undefined
}

/** Parse the `mcpServers` body field — the same `AcpMcpServer[]` shape
 *  the MCP tool accepts, tolerant of a JSON-stringified array (see
 *  `parseOrchestratorField`). Entries missing a valid `name`/`transport`
 *  are dropped rather than failing the whole array. */
function parseMcpServersField(raw: unknown): AcpMcpServer[] | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!Array.isArray(value)) return undefined
  const servers: AcpMcpServer[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.name !== "string") continue
    if (o.transport !== "stdio" && o.transport !== "http" && o.transport !== "sse") continue
    servers.push({
      name: o.name,
      transport: o.transport,
      ...(typeof o.ref === "string" ? { ref: o.ref } : {}),
    })
  }
  return servers
}

/** Parse the `auth` body field — `{ mode?, token?, apiKey? }`, tolerant of a
 *  JSON-stringified object (see `parseOrchestratorField`). Deliberately
 *  narrow: only the known keys survive, so an unrelated stray field can't
 *  smuggle anything unexpected into the resolved spawn config. */
function parseAuthField(
  raw: unknown,
): { mode?: "subscription" | "api-key"; token?: string; apiKey?: string } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const mode = obj.mode === "subscription" || obj.mode === "api-key" ? obj.mode : undefined
  const token = typeof obj.token === "string" ? obj.token : undefined
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : undefined
  return {
    ...(mode ? { mode } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
  resolveAgentAdapter?: AgentAdapterResolver,
  ptyEnabled = false,
  resolveBrowserAdapter?: BrowserAdapterResolver,
  listBrowserAdapters?: BrowserAdapterLister,
  sessionEvents?: SessionEventBus,
  eventRing?: EventRing,
  buildOrchestratorMcp?: BuildOrchestratorMcp,
  daemonMcpUrl?: string,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/sessions" && req.method === "GET") {
    json(200, { sessions: registry.list() })
    return true
  }

  // Long-running agent session — spawn via the cli's adapter
  // resolver, hold across multiple turns. Body shape:
  //   {adapter: "claude-code"|"hermes"|...,
  //    workspaceSlug, cwd, prompt?, label?, orchestrator?, mcpServers?}
  // Delegates to the same `spawnAgentSession` the MCP `agent_start`
  // tool uses (session-spawn.ts) — keeps this route from re-implementing
  // (and re-drifting from) the orchestrator/mcpServers/hermes-default
  // logic that lives there.
  if (path === "/sessions/agent" && req.method === "POST") {
    if (!resolveAgentAdapter) {
      json(501, {
        error: "agent_resolver_not_configured",
        message:
          "POST /sessions/agent needs the host to inject `resolveAgentAdapter` " +
          "(e.g. via @agentproto/cli's resolveAdapter shim).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const adapter = typeof b.adapter === "string" ? b.adapter : ""
    if (!adapter) {
      json(400, { error: "missing_adapter" })
      return true
    }
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter, buildOrchestratorMcp, daemonMcpUrl },
      {
        adapter,
        ...(typeof b.cwd === "string" && b.cwd.length > 0 ? { cwd: b.cwd } : {}),
        ...(typeof b.workspaceSlug === "string" && b.workspaceSlug.length > 0
          ? { workspaceSlug: b.workspaceSlug }
          : {}),
        ...(typeof b.resumeSessionId === "string" && b.resumeSessionId.length > 0
          ? { resumeSessionId: b.resumeSessionId }
          : {}),
        ...(typeof b.mode === "string" && b.mode.length > 0 ? { mode: b.mode } : {}),
        ...(typeof b.model === "string" && b.model.length > 0 ? { model: b.model } : {}),
        ...(typeof b.effort === "string" && b.effort.length > 0 ? { effort: b.effort } : {}),
        ...(b.auth !== undefined
          ? (() => {
              const parsed = parseAuthField(b.auth)
              return parsed !== undefined ? { auth: parsed } : {}
            })()
          : {}),
        ...(typeof b.prompt === "string" ? { prompt: b.prompt } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
        ...(typeof b.role === "string" && b.role.length > 0 ? { role: b.role } : {}),
        ...(typeof b.promptAppend === "string" ? { promptAppend: b.promptAppend } : {}),
        ...(b.orchestrator !== undefined
          ? (() => {
              const parsed = parseOrchestratorField(b.orchestrator)
              return parsed !== undefined ? { orchestrator: parsed } : {}
            })()
          : {}),
        ...(b.mcpServers !== undefined
          ? (() => {
              const parsed = parseMcpServersField(b.mcpServers)
              return parsed !== undefined ? { mcpServers: parsed } : {}
            })()
          : {}),
        // Opt this session into Langfuse tracing — the HTTP twin of the
        // MCP `agent_start` tool's `trace` field. Tolerate a stringified
        // boolean (JSON `true`, or `"true"`/`"false"` from form-ish callers)
        // so the REST driver reaches the same registry gate the MCP tool does.
        ...(b.trace !== undefined
          ? (() => {
              const t =
                typeof b.trace === "boolean"
                  ? b.trace
                  : b.trace === "true"
                    ? true
                    : b.trace === "false"
                      ? false
                      : undefined
              return t !== undefined ? { trace: t } : {}
            })()
          : {}),
        // Permission-hold mode — the HTTP twin of the MCP `agent_start` tool's
        // `permissionHold` field (and `agentproto sessions start
        // --hold-permissions`). Tolerate a stringified boolean like `trace`.
        ...(b.permissionHold !== undefined
          ? (() => {
              const h =
                typeof b.permissionHold === "boolean"
                  ? b.permissionHold
                  : b.permissionHold === "true"
                    ? true
                    : b.permissionHold === "false"
                      ? false
                      : undefined
              return h ? { permissionHold: true } : {}
            })()
          : {}),
      },
    )
    if (!result.ok) {
      const status =
        result.code === "adapter_not_found" || result.code === "no_cwd"
          ? 404
          : result.code === "orchestrator_not_enabled"
            ? 501
            : result.code === "orchestrator_max_depth_exceeded" ||
                result.code === "orchestrator_child_quota_exceeded" ||
                result.code === "role_spawn_denied"
              ? 409
              : result.code === "invalid_role"
                ? 400
                : 500
      json(status, {
        error: result.code,
        message: result.message,
        ...result.details,
      })
      return true
    }
    json(201, result.descriptor)
    return true
  }

  // Browser service session — start the adapter and register as a tracked
  // session. HTTP equivalent of the MCP `start_browser` tool.
  // Body: { adapter: string, port?: number, camofoxPort?: number, label?: string,
  //         location?: "local"|"cloud", baseUrl?: string, binPath?: string }
  if (path === "/sessions/browser" && req.method === "POST") {
    if (!resolveBrowserAdapter) {
      json(501, {
        error: "browser_resolver_not_configured",
        message:
          "POST /sessions/browser needs the host to inject `resolveBrowserAdapter` " +
          "(e.g. via `agentproto serve`).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const adapterId = typeof b.adapter === "string" ? b.adapter : ""
    if (!adapterId) {
      json(400, { error: "missing_adapter" })
      return true
    }
    const rawPort = b.port
    if (rawPort !== undefined) {
      const p = typeof rawPort === "number" ? rawPort : Number(rawPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        json(400, {
          error: "invalid_port",
          message: `port must be an integer in range 1–65535 (got ${JSON.stringify(rawPort)})`,
        })
        return true
      }
    }
    const rawCamofoxPort = b.camofoxPort
    if (rawCamofoxPort !== undefined) {
      const p = typeof rawCamofoxPort === "number" ? rawCamofoxPort : Number(rawCamofoxPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        json(400, {
          error: "invalid_camofox_port",
          message: `camofoxPort must be an integer in range 1–65535 (got ${JSON.stringify(rawCamofoxPort)})`,
        })
        return true
      }
    }
    const adapter = resolveBrowserAdapter(adapterId)
    if (!adapter) {
      const available = listBrowserAdapters
        ? listBrowserAdapters()
            .map(a => a.id)
            .join(", ")
        : "camofox, bureau"
      json(404, {
        error: "adapter_not_found",
        adapter: adapterId,
        message: `Browser adapter "${adapterId}" not found. Available: ${available}.`,
      })
      return true
    }
    const rawLocation = b.location
    if (rawLocation !== undefined && rawLocation !== "local" && rawLocation !== "cloud") {
      json(400, {
        error: "invalid_location",
        message: `location must be "local" or "cloud" (got ${JSON.stringify(rawLocation)})`,
      })
      return true
    }
    const location = rawLocation as "local" | "cloud" | undefined
    const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl : undefined
    const binPath = typeof b.binPath === "string" ? b.binPath : undefined
    try {
      const instance = await adapter.ensure({
        port: typeof b.port === "number" ? b.port : undefined,
        camofoxPort: typeof b.camofoxPort === "number" ? b.camofoxPort : undefined,
        location,
        baseUrl,
        binPath,
        initialWaitMs: 6_000,
      })
      const desc = registry.registerBrowser({
        adapterId: instance.id,
        port: instance.port,
        baseUrl: instance.baseUrl,
        location: location ?? adapter.location,
        pid: instance.pid,
        wasAlreadyRunning: instance.wasAlreadyRunning,
        status: instance.healthy ? "running" : "starting",
        stop: instance.stop.bind(instance),
        label: typeof b.label === "string" ? b.label : undefined,
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "browser_start_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Long-running PTY session — spawn argv under node-pty. Bytes flow
  // through the registry's byte ring buffer; attach via the WebSocket
  // upgrade at /sessions/:id/pty. Body shape:
  //   {argv: string[], cwd?, workspaceSlug?, cols, rows, env?, name?, label?}
  if (path === "/sessions/terminal" && req.method === "POST") {
    if (!ptyEnabled) {
      json(501, {
        error: "pty_not_configured",
        message:
          "POST /sessions/terminal needs the host to inject `spawnPty` into createGateway " +
          "(node-pty optional dep — install in @agentproto/cli).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const argv = Array.isArray(b.argv)
      ? (b.argv as unknown[]).filter((v): v is string => typeof v === "string")
      : []
    if (argv.length === 0) {
      json(400, { error: "missing_argv" })
      return true
    }
    const cols = typeof b.cols === "number" && b.cols > 0 ? Math.floor(b.cols) : 80
    const rows = typeof b.rows === "number" && b.rows > 0 ? Math.floor(b.rows) : 24
    // cwd resolution mirrors /sessions/agent exactly.
    let cwd: string | null =
      typeof b.cwd === "string" && b.cwd.length > 0 ? b.cwd : null
    let workspaceSlug =
      typeof b.workspaceSlug === "string" ? b.workspaceSlug : ""
    if (!cwd) {
      try {
        const config = await loadWorkspacesConfig()
        const ws = workspaceSlug
          ? findWorkspace(config, workspaceSlug)
          : getActiveWorkspace(config)
        if (ws) {
          cwd = ws.path
          workspaceSlug = ws.slug
        }
      } catch {
        // fall through to process.cwd()
      }
    }
    if (!cwd) {
      cwd = process.cwd()
      console.warn(
        `[/sessions/terminal] no cwd resolvable for argv=${argv.join(" ")} ` +
          `— falling back to daemon's cwd ${cwd}`
      )
    }
    if (!workspaceSlug) workspaceSlug = "default"
    try {
      const desc = registry.spawnPty({
        argv,
        cwd,
        workspaceSlug,
        cols,
        rows,
        ...(b.env && typeof b.env === "object"
          ? { env: b.env as Record<string, string> }
          : {}),
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
      })
      json(201, desc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("already in use")
        ? 409
        : msg.includes("no PTY factory")
          ? 501
          : 500
      json(status, { error: "pty_spawn_failed", message: msg })
    }
    return true
  }

  // Send a follow-up turn to a live agent session.
  // Body: { prompt: string | ContentBlock | ContentBlock[], interrupt?: boolean }
  //   - string                → auto-wrapped to a single text block by
  //                             the registry (legacy / convenience).
  //   - ContentBlock          → e.g. `{type:"image", source:{...}}`
  //   - ContentBlock[]        → text + image mix for multimodal turns.
  //                             Forwarded as-is to `agentSession.send`
  //                             so the adapter (claude-agent-acp, …)
  //                             negotiates its own content shape.
  //   - interrupt             → when true and the session is mid-turn,
  //                             cancel the in-flight turn and deliver
  //                             this prompt on the same session instead
  //                             of the usual mid-turn rejection. No-op
  //                             on an idle session. Default false.
  //
  // Validation is intentionally loose — we accept anything object-
  // shaped + non-empty arrays + non-empty strings. The adapter will
  // reject ill-formed blocks with a clear error projected into the
  // session's ring buffer; throwing here would just duplicate that.
  //
  // Query: ?wait=false → fire-and-forget (return 202 after sync
  //   validation; output streams via /sessions/:id/stream). Default
  //   wait=true keeps the call blocking until the turn drains, which
  //   is what curl scripts + the MCP bridge expect. `interrupt` only
  //   takes effect on this fire-and-forget arm (mirroring MCP
  //   `agent_prompt`, which always calls `enqueuePrompt`).
  const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompt$/)
  if (promptMatch && req.method === "POST") {
    const id = promptMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const prompt = (body as { prompt?: unknown } | null)?.prompt
    const interrupt = (body as { interrupt?: unknown } | null)?.interrupt === true
    const validPrompt =
      (typeof prompt === "string" && prompt.length > 0) ||
      (Array.isArray(prompt) &&
        prompt.length > 0 &&
        prompt.every(b => b !== null && typeof b === "object")) ||
      (prompt !== null && typeof prompt === "object" && !Array.isArray(prompt))
    if (!validPrompt) {
      json(400, {
        error: "missing_prompt",
        message:
          "Body `prompt` must be a non-empty string, a content block object, or an array of content blocks.",
      })
      return true
    }
    const reqUrl = req.url ?? ""
    const queryString = reqUrl.includes("?")
      ? reqUrl.slice(reqUrl.indexOf("?") + 1)
      : ""
    const wait = new URLSearchParams(queryString).get("wait")
    const fireAndForget = wait === "false" || wait === "0"
    try {
      if (fireAndForget) {
        // Awaited: enqueuePrompt only resolves once the resume attempt
        // (if any) + admission checks pass — a dead or busy session
        // rejects here, before the 202 goes out, instead of us
        // reporting `queued: true` for a prompt nothing will dispatch.
        // `interrupt: true` lets a mid-turn session redirect instead of
        // rejecting — see `SessionsRegistry.enqueuePrompt`'s doc comment.
        await registry.enqueuePrompt(id, prompt, { interrupt })
        json(202, { ok: true, id, queued: true })
      } else {
        await registry.sendPrompt(id, prompt)
        json(200, { ok: true, id })
      }
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        json(409, { error: "session_not_alive", status: err.status })
        return true
      }
      const msg = err instanceof Error ? err.message : String(err)
      // Differentiate "not found" / "wrong kind" / "busy" — they
      // surface as readable thrown messages from the registry.
      const status = msg.includes("no session")
        ? 404
        : msg.includes("not an agent")
          ? 400
          : msg.includes("mid-turn")
            ? 409
            : 500
      json(status, { error: "send_prompt_failed", message: msg })
    }
    return true
  }

  if (path === "/sessions" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const argv = Array.isArray(b.argv)
      ? (b.argv as unknown[]).filter((v): v is string => typeof v === "string")
      : []
    if (argv.length === 0) {
      json(400, { error: "missing_argv" })
      return true
    }
    try {
      const desc = registry.spawn({
        kind:
          b.kind === "terminal" || b.kind === "agent-cli" || b.kind === "command"
            ? b.kind
            : "command",
        workspaceSlug:
          typeof b.workspaceSlug === "string" ? b.workspaceSlug : "default",
        cwd: typeof b.cwd === "string" ? b.cwd : process.cwd(),
        argv,
        env:
          b.env && typeof b.env === "object"
            ? (b.env as Record<string, string>)
            : undefined,
        label: typeof b.label === "string" ? b.label : undefined,
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Per-id routes. The `:id` slot also accepts a session's `name`
  // when one was set at spawn time — `findByIdOrName` resolves both
  // and the rest of the handler operates on the canonical id.
  const idMatch = path.match(
    /^\/sessions\/([^/]+)(\/stream|\/kill|\/preview|\/export|\/events|\/wait)?$/,
  )
  if (!idMatch) return false
  const [, rawIdOrName, suffix] = idMatch
  if (!rawIdOrName) return false
  const resolvedDesc = registry.findByIdOrName(rawIdOrName)
  const id = resolvedDesc?.id ?? rawIdOrName

  if (suffix === "/export" && req.method === "GET") {
    // Transcript export — reads the adapter's native persistence layer
    // (claude-code JSONL / hermes SQLite) and returns a rendered
    // transcript. Query params: format (markdown|json), adapter, cwd.
    // Read-only GET, no auth gate (same policy as /preview).
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const fmt = qs.get("format") === "json" ? "json" as const : "markdown" as const
    const adapterOverride = qs.get("adapter") ?? undefined
    const cwdOverride = qs.get("cwd") ?? undefined
    const sourceParam = qs.get("source")
    const source =
      sourceParam === "native" || sourceParam === "daemon" ? sourceParam : undefined
    const result = await exportAgentSession({
      sessionId: rawIdOrName,
      registry,
      format: fmt,
      ...(adapterOverride ? { adapter: adapterOverride } : {}),
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(source ? { source } : {}),
    })
    if (result.content.startsWith("Error:")) {
      const isNotFound =
        result.content.includes("not found in registry") ||
        result.content.includes("not found") ||
        result.content.includes("not found")
      json(isNotFound ? 404 : 422, {
        error: "export_failed",
        message: result.content,
        sessionId: rawIdOrName,
        adapter: result.adapter,
      })
    } else {
      json(200, result)
    }
    return true
  }

  if (suffix === "/events" && req.method === "GET") {
    // Raw structured events.jsonl records — the same on-disk capture
    // /export's daemon-events strategy reads, exposed directly so a web
    // panel can render rich components instead of the collapsed
    // markdown/JSON transcript. Read-only GET, no auth gate (same
    // policy as /export / /preview).
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sinceRaw = qs.get("since")
    if (sinceRaw !== null && !/^\d+$/.test(sinceRaw)) {
      json(400, {
        error: "invalid_since",
        message: "since must be a non-negative integer",
      })
      return true
    }
    const since = sinceRaw !== null ? Number.parseInt(sinceRaw, 10) : 0
    const limit = clampInt(qs.get("limit"), 500, 1, 2000)

    // events.jsonl is always keyed by the agentproto session id (same
    // resolution export's daemon-events strategy relies on) — `id` above
    // already resolved to that via findByIdOrName, falling back to the
    // raw path segment when the registry doesn't know it.
    const filePath = sessionEventsPath(id)
    let fileStream: ReturnType<typeof createReadStream>
    try {
      fileStream = createReadStream(filePath, { encoding: "utf8" })
      await new Promise<void>((resolve, reject) => {
        fileStream.once("error", reject)
        fileStream.once("open", resolve)
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        json(404, { error: "no_transcript" })
        return true
      }
      throw err
    }

    const events: Record<string, unknown>[] = []
    let truncated = false
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof rec.seq !== "number" || rec.seq <= since) continue
      if (events.length >= limit) {
        truncated = true
        continue
      }
      events.push(rec)
    }

    const nextSeq =
      events.length > 0 ? (events[events.length - 1]?.seq as number) : since
    json(200, {
      sessionId: id,
      events,
      nextSeq,
      complete: !truncated,
    })
    return true
  }

  if (suffix === "/preview" && req.method === "GET") {
    // Read-only snapshot of the recent ring buffer — used by the
    // dashboard's detail pane so the user sees what the session was
    // doing without committing to an attach. Returns BOTH lines
    // (for agent-cli/command sessions) and recent-bytes (for PTY).
    // Caller picks whichever is populated.
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const lineCap = clampInt(qs.get("lines"), 10, 1, 200)
    const byteCap = clampInt(qs.get("bytes"), 16 * 1024, 256, 64 * 1024)
    // No registry method exists for "give me the recent buffer
    // snapshot" — readTerminalOutput is the closest. For non-PTY
    // sessions, attach with a no-op subscriber, read backfill,
    // detach. Cheap; the backfill is synchronous on attach.
    const lines: string[] = []
    if (resolvedDesc.pty !== true) {
      const unsub = registry.attach(id, line => {
        lines.push(line)
      })
      if (unsub) unsub()
    }
    const bufBytes = registry.readTerminalOutput(id, byteCap)
    json(200, {
      id: resolvedDesc.id,
      lines: lines.slice(-lineCap),
      bytes: bufBytes ? bufBytes.toString("base64") : null,
    })
    return true
  }

  if (suffix === "/wait" && req.method === "GET") {
    // Blocking long-poll — same machinery as the MCP `session_monitor`
    // tool (monitorSessionWait). Resolves when the session fires a
    // matching lifecycle event, or when timeoutMs elapses. Read-only GET,
    // no auth gate (same policy as /preview / /stream).
    if (!sessionEvents || !eventRing) {
      json(501, {
        error: "wait_not_configured",
        message:
          "GET /sessions/:id/wait needs the host to wire `sessionEvents` + `eventRing` " +
          "into the HTTP server (the daemon does this in createGateway).",
      })
      return true
    }
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    // 404 when the session is unknown AND no `since` cursor was passed —
    // a cursor implies "replay events I might have missed", so we still
    // honour it for a now-dead session. Without a cursor, waiting on a
    // missing session would block until timeout for nothing.
    if (!resolvedDesc && qs.get("since") === null) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const rawEvent = qs.get("event")
    const event: SessionWaitEvent =
      rawEvent === "turn-end" ||
      rawEvent === "awaiting-input" ||
      rawEvent === "exited" ||
      rawEvent === "any"
        ? (rawEvent as SessionWaitEvent)
        : "any"
    const rawSince = qs.get("since")
    const since =
      rawSince !== null && /^\d+$/.test(rawSince)
        ? Number.parseInt(rawSince, 10)
        : undefined
    // Cap at 55s to stay under typical HTTP client/proxy timeouts; the
    // CLI chains multiple calls when its total --timeout exceeds this.
    const timeoutMs = clampInt(qs.get("timeoutMs"), 25_000, 1_000, 55_000)
    const result = await monitorSessionWait({
      registry,
      sessionEvents,
      eventRing,
      sessionIds: [id],
      event,
      timeoutMs,
      ...(since !== undefined ? { since } : {}),
    })
    json(200, result)
    return true
  }

  if (suffix === "/stream" && req.method === "GET") {
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    // Keep-alive ping every 25s — proxies / browsers eventually
    // close idle SSE connections; the comment line keeps the pipe
    // warm without confusing the EventSource parser (it ignores
    // anything starting with `:`).
    const ping = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`)
      } catch {
        clearInterval(ping)
      }
    }, 25_000)
    const unsub = registry.attach(id, (line, stream) => {
      try {
        res.write(
          `data: ${JSON.stringify({ line, stream })}\n\n`
        )
      } catch {
        // Client gone — cleanup happens on `close`.
      }
    })
    if (!unsub) {
      clearInterval(ping)
      res.end()
      return true
    }
    req.once("close", () => {
      unsub()
      clearInterval(ping)
    })
    return true
  }

  if (suffix === "/kill" && req.method === "POST") {
    const ok = registry.kill(id)
    json(ok ? 200 : 404, { ok, sessionId: id })
    return true
  }

  if (!suffix && req.method === "GET") {
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    json(200, resolvedDesc)
    return true
  }

  if (!suffix && req.method === "DELETE") {
    const ok = registry.forget(id)
    json(ok ? 200 : 404, { ok, id })
    return true
  }

  return false
}

/**
 * /presets route — list built-in provider gateway presets with live key-env
 * status. Static data (no registry), so this route is registered
 * unconditionally — no opt-in flag like /tunnels's TunnelRegistry.
 *
 *   GET /presets → { presets: AdapterEntry<PresetInfo>[] }
 *
 * Status reflects THIS process's environment (the daemon's — i.e. where agents
 * spawn), not the CLI caller's: "ready" when the provider's key env var is set,
 * "available" otherwise.
 */
async function handlePresets(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/presets" && req.method === "GET") {
    json(200, { presets: listPresets() })
    return true
  }
  return false
}

/**
 * /tunnels routes — create, list, get, and stop public tunnels.
 * Returns `true` when it handled the request so the dispatcher
 * skips the 404 path.
 *
 *   GET    /tunnels              → { tunnels: TunnelDescriptor[] }
 *   POST   /tunnels              → TunnelDescriptor (creates a new tunnel)
 *   GET    /tunnels/:id          → TunnelDescriptor
 *   DELETE /tunnels/:id          → { ok, tunnelId }
 */
async function handleTunnels(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: TunnelRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/tunnels" && req.method === "GET") {
    const urlStr = req.url ?? ""
    const qs = urlStr.includes("?")
      ? new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1))
      : new URLSearchParams()
    const onlyActive = qs.get("onlyActive") === "true"
    let tunnels = registry.list()
    if (onlyActive) {
      tunnels = tunnels.filter(
        t => t.status === "starting" || t.status === "active",
      )
    }
    json(200, { tunnels })
    return true
  }

  if (path === "/tunnels" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const targetPort =
      typeof b.targetPort === "number" && b.targetPort > 0
        ? Math.floor(b.targetPort)
        : null
    if (!targetPort) {
      json(400, {
        error: "missing_targetPort",
        message: "body must include `targetPort` (integer 1-65535)",
      })
      return true
    }
    try {
      const desc = await registry.create({
        targetPort,
        // Any provider slug (built-in, legacy alias, or third-party) — the
        // registry resolves/validates it and surfaces an unknown slug as a
        // create_failed error below.
        ...(typeof b.provider === "string" ? { provider: b.provider } : {}),
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
        ...(typeof b.targetHost === "string" ? { targetHost: b.targetHost } : {}),
        ...(b.autostart === true ? { autostart: true } : {}),
        ...(typeof b.hostname === "string" ? { hostname: b.hostname } : {}),
        ...(typeof b.tunnelId === "string" ? { tunnelId: b.tunnelId } : {}),
        ...(typeof b.credentialsFile === "string"
          ? { credentialsFile: b.credentialsFile }
          : {}),
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  const tunnelMatch = path.match(/^\/tunnels\/([^/]+)$/)
  if (!tunnelMatch) return false
  const rawIdOrName = decodeURIComponent(tunnelMatch[1] ?? "")

  if (req.method === "GET") {
    const desc = registry.findByIdOrName(rawIdOrName)
    if (!desc) {
      json(404, { error: "tunnel_not_found", id: rawIdOrName })
      return true
    }
    json(200, desc)
    return true
  }

  if (req.method === "DELETE") {
    const ok = await registry.stop(rawIdOrName)
    if (!ok) {
      json(404, { error: "tunnel_not_found", id: rawIdOrName })
      return true
    }
    json(200, { ok, tunnelId: rawIdOrName })
    return true
  }

  return false
}

/**
 * /routines routes — start, list, poll, cancel, and resolve escalations
 * for background routine runs (a flat sequential list of steps with
 * per-step `waitFor` fan-in). Returns `true` when it handled the
 * request so the dispatcher skips the 404 path.
 *
 *   POST /routines                          → start a run (RoutineRun)
 *   GET  /routines                          → { runs: RoutineRun[] }
 *   GET  /routines/:id                      → RoutineRun
 *   POST /routines/:id/cancel               → { runId, status }
 *   POST /routines/:id/escalation/resolve   → { runId, ok }
 *
 * Thin adapters over the same RoutineRunner the MCP `routine_start/
 * status/cancel/escalation_resolve/list` tools call — no duplicated
 * orchestration logic between the two transports.
 */
async function handleRoutines(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  routineRunner: RoutineRunner,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/routines" && req.method === "GET") {
    json(200, { runs: routineRunner.list() })
    return true
  }

  if (path === "/routines" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const routineId = typeof b.routineId === "string" ? b.routineId : ""
    if (!routineId) {
      json(400, { error: "missing_routineId" })
      return true
    }
    if (!Array.isArray(b.steps) || b.steps.length === 0) {
      json(400, {
        error: "missing_steps",
        message: "body must include a non-empty `steps` array",
      })
      return true
    }
    try {
      const run = await routineRunner.start({
        routineId,
        steps: b.steps as RoutineStep[],
        ...(typeof b.workspaceSlug === "string" ? { workspaceSlug: b.workspaceSlug } : {}),
        ...(typeof b.cwd === "string" ? { cwd: b.cwd } : {}),
        ...(typeof b.notifyUrl === "string" ? { notifyUrl: b.notifyUrl } : {}),
      })
      json(201, run)
    } catch (err) {
      json(400, {
        error: "start_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /routines/:id/cancel
  const cancelMatch = path.match(/^\/routines\/([^/]+)\/cancel$/)
  if (cancelMatch && req.method === "POST") {
    const runId = decodeURIComponent(cancelMatch[1] ?? "")
    if (!routineRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    routineRunner.cancel(runId)
    const run = routineRunner.status(runId)
    json(200, { runId, status: run?.status ?? "not_found" })
    return true
  }

  // /routines/:id/escalation/resolve
  const resolveMatch = path.match(/^\/routines\/([^/]+)\/escalation\/resolve$/)
  if (resolveMatch && req.method === "POST") {
    const runId = decodeURIComponent(resolveMatch[1] ?? "")
    if (!routineRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const stepIndex = typeof b.stepIndex === "number" ? b.stepIndex : undefined
    const response = typeof b.response === "string" ? b.response : undefined
    if (stepIndex === undefined || response === undefined) {
      json(400, {
        error: "invalid_body",
        message: "body must include `stepIndex` (number) and `response` (string)",
      })
      return true
    }
    routineRunner.resolve(runId, stepIndex, response)
    json(200, { runId, ok: true })
    return true
  }

  // /routines/:id
  const idMatch = path.match(/^\/routines\/([^/]+)$/)
  if (idMatch && req.method === "GET") {
    const runId = decodeURIComponent(idMatch[1] ?? "")
    const run = routineRunner.status(runId)
    if (!run) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    json(200, run)
    return true
  }

  return false
}

/**
 * /workflows routes — start, list, poll, cancel, and resolve escalations
 * for background workflow runs (ordered stages of steps that run
 * concurrently within a stage, gated by a barrier). Returns `true` when
 * it handled the request so the dispatcher skips the 404 path.
 *
 *   POST /workflows                          → start a run (WorkflowRun)
 *   GET  /workflows                          → { runs: WorkflowRun[] }
 *   GET  /workflows/:id                      → WorkflowRun
 *   POST /workflows/:id/cancel               → { runId, status }
 *   POST /workflows/:id/escalation/resolve   → { runId, ok }
 *
 * Thin adapters over the same WorkflowRunner the MCP `workflow_start/
 * status/cancel/escalation_resolve/list` tools call — no duplicated
 * orchestration logic between the two transports.
 */
async function handleWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  workflowRunner: WorkflowRunner,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/workflows" && req.method === "GET") {
    json(200, { runs: workflowRunner.list() })
    return true
  }

  if (path === "/workflows" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const workflowId = typeof b.workflowId === "string" ? b.workflowId : ""
    if (!workflowId) {
      json(400, { error: "missing_workflowId" })
      return true
    }
    if (!Array.isArray(b.stages) || b.stages.length === 0) {
      json(400, {
        error: "missing_stages",
        message: "body must include a non-empty `stages` array",
      })
      return true
    }
    try {
      const run = await workflowRunner.start({
        workflowId,
        stages: b.stages as WorkflowStage[],
        ...(typeof b.workspaceSlug === "string" ? { workspaceSlug: b.workspaceSlug } : {}),
        ...(typeof b.cwd === "string" ? { cwd: b.cwd } : {}),
        ...(typeof b.notifyUrl === "string" ? { notifyUrl: b.notifyUrl } : {}),
      })
      json(201, run)
    } catch (err) {
      json(400, {
        error: "start_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /workflows/:id/cancel
  const cancelMatch = path.match(/^\/workflows\/([^/]+)\/cancel$/)
  if (cancelMatch && req.method === "POST") {
    const runId = decodeURIComponent(cancelMatch[1] ?? "")
    if (!workflowRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    workflowRunner.cancel(runId)
    const run = workflowRunner.status(runId)
    json(200, { runId, status: run?.status ?? "not_found" })
    return true
  }

  // /workflows/:id/escalation/resolve
  const resolveMatch = path.match(/^\/workflows\/([^/]+)\/escalation\/resolve$/)
  if (resolveMatch && req.method === "POST") {
    const runId = decodeURIComponent(resolveMatch[1] ?? "")
    if (!workflowRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const stageIndex = typeof b.stageIndex === "number" ? b.stageIndex : undefined
    const stepIndex = typeof b.stepIndex === "number" ? b.stepIndex : undefined
    const response = typeof b.response === "string" ? b.response : undefined
    if (stageIndex === undefined || stepIndex === undefined || response === undefined) {
      json(400, {
        error: "invalid_body",
        message:
          "body must include `stageIndex` (number), `stepIndex` (number), and `response` (string)",
      })
      return true
    }
    workflowRunner.resolve(runId, stageIndex, stepIndex, response)
    json(200, { runId, ok: true })
    return true
  }

  // /workflows/:id
  const idMatch = path.match(/^\/workflows\/([^/]+)$/)
  if (idMatch && req.method === "GET") {
    const runId = decodeURIComponent(idMatch[1] ?? "")
    const run = workflowRunner.status(runId)
    if (!run) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    json(200, run)
    return true
  }

  return false
}

/**
 * /policies routes — attach, list, cancel, ack, and blocking-wait for
 * completion policies. Returns `true` when it handled the request so
 * the dispatcher skips the 404 path.
 *
 *   POST /policies              → attach a policy (PolicyRunState)
 *   GET  /policies              → { policies: PolicyRunState[] }
 *   POST /policies/:id/cancel   → { policyId, status }
 *   POST /policies/:id/ack      → { policyId, status, sha?, error? }
 *   GET  /policies/:id/wait     → block until the policy resolves, then
 *                                 return the full PolicyRunState. Same
 *                                 shape the MCP `policy_status` tool
 *                                 returns. `{timedOut:true}` when
 *                                 `timeoutMs` elapses with no resolution.
 *
 * Thin adapters over the same CompletionPolicySupervisor the MCP
 * `policy_attach/status/cancel/ack/list` tools call — no duplicated
 * policy-state-machine logic between the two transports. Only mounted
 * when a supervisor is wired (the dispatcher guards on `opts.supervisor`).
 */
async function handlePolicies(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  supervisor: CompletionPolicySupervisor,
  registry?: SessionsRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/policies" && req.method === "GET") {
    json(200, { policies: supervisor.list() })
    return true
  }

  if (path === "/policies" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const sessionId = typeof b.sessionId === "string" ? b.sessionId : undefined
    const sessionIds = Array.isArray(b.sessionIds)
      ? b.sessionIds.filter((s): s is string => typeof s === "string")
      : undefined
    if (!sessionId && !(sessionIds && sessionIds.length > 0)) {
      json(400, {
        error: "missing_sessions",
        message: "body must include `sessionId` or a non-empty `sessionIds`",
      })
      return true
    }
    const then = b.then as "emit" | "commit"
    if (then !== "emit" && then !== "commit") {
      json(400, { error: "invalid_then", message: 'body.then must be "emit" or "commit"' })
      return true
    }
    if (then === "commit" && !b.commit) {
      json(400, {
        error: "missing_commit",
        message: 'then:"commit" requires a `commit` spec',
      })
      return true
    }
    try {
      const state = supervisor.attach({
        ...(sessionId ? { sessionId } : {}),
        ...(sessionIds && sessionIds.length > 0 ? { sessionIds } : {}),
        ...(b.gate ? { gate: b.gate as AttachPolicyInput["gate"] } : {}),
        then,
        ...(b.commit ? { commit: b.commit as AttachPolicyInput["commit"] } : {}),
        ...(b.onFail ? { onFail: b.onFail as AttachPolicyInput["onFail"] } : {}),
        ...(b.next ? { next: b.next as AttachPolicyInput["next"] } : {}),
      })
      json(201, state)
    } catch (err) {
      json(400, {
        error: "attach_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /policies/:id/cancel
  const cancelMatch = path.match(/^\/policies\/([^/]+)\/cancel$/)
  if (cancelMatch && req.method === "POST") {
    const policyId = decodeURIComponent(cancelMatch[1] ?? "")
    if (!supervisor.getStatus(policyId)) {
      json(404, { error: "policy_not_found", policyId })
      return true
    }
    supervisor.cancel(policyId)
    const state = supervisor.getStatus(policyId)
    json(200, { policyId, status: state?.status ?? "not_found" })
    return true
  }

  // /policies/:id/ack
  const ackMatch = path.match(/^\/policies\/([^/]+)\/ack$/)
  if (ackMatch && req.method === "POST") {
    const policyId = decodeURIComponent(ackMatch[1] ?? "")
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const approve = typeof b.approve === "boolean" ? b.approve : undefined
    if (approve === undefined) {
      json(400, { error: "missing_approve", message: "body must include boolean `approve`" })
      return true
    }
    const state = await supervisor.ack(policyId, approve)
    if (!state) {
      json(404, { error: "policy_not_found", policyId })
      return true
    }
    json(200, {
      policyId: state.policyId,
      status: state.status,
      ...(state.commitSha ? { sha: state.commitSha } : {}),
      ...(state.error ? { error: state.error } : {}),
    })
    return true
  }

  // /policies/:id/wait — block until the named completion policy
  // transitions out of watching/queued/gating/nudging (i.e. reaches
  // done/blocked/awaiting-ack/cancelled), then return the full
  // PolicyRunState. Query params: timeoutMs=<n> (default 25000, cap
  // 55000 to stay under typical HTTP client/proxy timeouts; the CLI
  // chains multiple calls for longer budgets). Read-only GET — no auth
  // gate, same policy as the other /sessions read routes.
  const waitMatch = path.match(/^\/policies\/([^/]+)\/wait$/)
  if (!waitMatch) return false
  const policyId = decodeURIComponent(waitMatch[1] ?? "")
  if (!policyId) return false
  if (req.method !== "GET") {
    json(405, { error: "method_not_allowed", message: "GET only" })
    return true
  }

  // Fast 404 when the policy doesn't exist at all — no point blocking.
  const current = supervisor.getStatus(policyId)
  if (!current) {
    json(404, { error: "policy_not_found", policyId })
    return true
  }

  const reqUrl = req.url ?? ""
  const qs = new URLSearchParams(
    reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
  )
  const timeoutMs = clampInt(qs.get("timeoutMs"), 25_000, 1_000, 55_000)

  const result = await monitorPolicyWait({
    supervisor,
    policyId,
    timeoutMs,
  })
  // monitorPolicyWait returns `{timedOut:false, state}` on resolution, or
  // `{timedOut:true}` on timeout. Forward the full PolicyRunState for parity
  // with policy_status — including the `awaitingQuestions` enrichment the
  // MCP policy_status tool applies (harness-parity): cross-reference the
  // watched sessions' live awaitingQuestion so a REST caller can tell
  // "stuck on a question" from "still legitimately running".
  if ("timedOut" in result && result.timedOut) {
    json(200, { timedOut: true, policyId })
    return true
  }
  const state = result.state
  if (registry) {
    const awaitingQuestions = state.sessionIds
      .map(id => ({ sessionId: id, desc: registry.get(id) }))
      .filter((s): s is { sessionId: string; desc: NonNullable<ReturnType<typeof registry.get>> } => !!s.desc?.awaitingInput)
      .map(s => ({ sessionId: s.sessionId, question: s.desc.awaitingQuestion }))
    if (awaitingQuestions.length > 0) {
      json(200, { ...state, awaitingQuestions })
      return true
    }
  }
  json(200, state)
  return true
}

/**
 * /permissions routes — the cross-session permission inbox:
 *   GET  /permissions            → { permissions: [...] } across all sessions
 *                                  (optional ?sessionId=<id> filter)
 *   POST /permissions/:id        → { decision, optionId?, scope? } approve/deny
 *
 * Mirrors the MCP `permissions_list` / `permissions_respond` tools over the
 * same SessionsRegistry inbox. Each list entry is enriched with the owning
 * session's adapter/title for a self-contained render.
 */
async function handlePermissions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/permissions" && req.method === "GET") {
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sessionId = qs.get("sessionId") ?? undefined
    const permissions = registry
      .listPendingPermissions(sessionId ? { sessionId } : undefined)
      .map(p => enrichPermission(p, registry))
    json(200, { permissions })
    return true
  }

  const idMatch = path.match(/^\/permissions\/([^/]+)$/)
  if (idMatch && req.method === "POST") {
    const id = decodeURIComponent(idMatch[1] ?? "")
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const decision = b.decision
    if (decision !== "approve" && decision !== "deny") {
      json(400, {
        error: "invalid_decision",
        message: 'body.decision must be "approve" or "deny"',
      })
      return true
    }
    const optionId = typeof b.optionId === "string" ? b.optionId : undefined
    const scope = b.scope === "always" || b.scope === "once" ? b.scope : undefined
    const result = await registry.respondPermission(id, {
      decision,
      ...(optionId ? { optionId } : {}),
      ...(scope ? { scope } : {}),
    })
    if (!result.ok) {
      const status = result.error === "not_found" || result.error === "session_gone" ? 404 : 409
      json(status, { error: result.error, message: result.message })
      return true
    }
    json(200, {
      ok: true,
      id,
      sessionId: result.permission.sessionId,
      decision: result.decision,
      ...(result.optionId ? { optionId: result.optionId } : {}),
    })
    return true
  }

  if (path === "/permissions" || idMatch) {
    json(405, { error: "method_not_allowed", message: "GET /permissions or POST /permissions/:id" })
    return true
  }
  return false
}

/** Enrich a raw PendingPermission with the owning session's adapter/title/age
 *  so a REST/MCP list entry is self-contained. */
function enrichPermission(
  p: import("./sessions.js").PendingPermission,
  registry: SessionsRegistry,
): Record<string, unknown> {
  const desc = registry.get(p.sessionId)
  const ageMs = Date.now() - new Date(p.requestedAt).getTime()
  return {
    ...p,
    ...(desc?.adapterSlug ? { adapter: desc.adapterSlug } : {}),
    ...(desc?.label ? { sessionLabel: desc.label } : {}),
    ...(desc?.command ? { sessionTitle: desc.command } : {}),
    ageMs: ageMs >= 0 ? ageMs : 0,
  }
}

/**
 * /pairings routes — E2E daemon pairing (design: DESIGN §6):
 *   POST   /pairings/offer         → { ttlMinutes?, rendezvous? } mint offer
 *                                    → { url, fingerprint, rendezvous, expiresAt }
 *   GET    /pairings               → { pairings: [...] }
 *   DELETE /pairings/:fingerprint  → revoke by fingerprint (or name)
 *
 * Mirrors the MCP `pair_offer` / `pair_list` / `pair_revoke` tools over the same
 * registry. Imitates the /permissions surface from #308.
 */
async function handlePairings(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: PairingRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/pairings/offer" && req.method === "POST") {
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const ttlMinutes = typeof b.ttlMinutes === "number" ? b.ttlMinutes : undefined
    const rendezvous = typeof b.rendezvous === "string" ? b.rendezvous : undefined
    try {
      const offer = await registry.createOffer({
        ...(ttlMinutes ? { ttlMs: ttlMinutes * 60_000 } : {}),
        ...(rendezvous ? { rendezvousUrl: rendezvous } : {}),
      })
      json(200, {
        url: offer.url,
        fingerprint: offer.fingerprint,
        rendezvous: offer.rendezvousUrl,
        expiresAt: new Date(offer.exp * 1000).toISOString(),
      })
    } catch (err) {
      json(400, {
        error: "offer_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  if (path === "/pairings" && req.method === "GET") {
    const pairings = (await registry.list()).map(p => ({
      name: p.name,
      fingerprint: p.fingerprint,
      createdAt: p.createdAt,
      lastSeen: p.lastSeen,
      rendezvous: p.rendezvousUrl,
    }))
    json(200, { pairings })
    return true
  }

  const fpMatch = path.match(/^\/pairings\/([^/]+)$/)
  if (fpMatch && req.method === "DELETE") {
    const target = decodeURIComponent(fpMatch[1] ?? "")
    const revoked = await registry.revoke(target)
    if (!revoked) {
      json(404, { error: "not_found", message: `no pairing matched "${target}"` })
      return true
    }
    json(200, { ok: true, revoked: target })
    return true
  }

  if (path === "/pairings" || path === "/pairings/offer" || fpMatch) {
    json(405, {
      error: "method_not_allowed",
      message: "POST /pairings/offer · GET /pairings · DELETE /pairings/:fingerprint",
    })
    return true
  }
  return false
}

/**
 * /cron routes:
 *   POST   /cron          → create a new cron job
 *   GET    /cron          → list all cron jobs
 *   DELETE /cron/:id      → delete a cron job
 *   POST   /cron/:id/run  → manually fire a cron job
 */
async function handleCron(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  scheduler: import("./cron-scheduler.js").CronScheduler,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/cron" && req.method === "GET") {
    json(200, { jobs: scheduler.list() })
    return true
  }

  if (path === "/cron" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const schedule = typeof b.schedule === "string" ? b.schedule : ""
    if (!schedule) {
      json(400, { error: "missing_schedule" })
      return true
    }
    const action = b.action
    if (!action || typeof action !== "object") {
      json(400, { error: "missing_action" })
      return true
    }
    try {
      const job = scheduler.create({
        label: typeof b.label === "string" ? b.label : undefined,
        schedule,
        recurring: typeof b.recurring === "boolean" ? b.recurring : true,
        action: action as import("./cron-scheduler.js").CronAction,
      })
      json(201, job)
    } catch (err) {
      json(400, {
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /cron/:id/run — manual fire
  const runMatch = path.match(/^\/cron\/([^/]+)\/run$/)
  if (runMatch && req.method === "POST") {
    const jobId = decodeURIComponent(runMatch[1] ?? "")
    try {
      const result = await scheduler.run(jobId)
      json(200, { jobId, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("not found") ? 404 : 500
      json(status, { error: "run_failed", message: msg })
    }
    return true
  }

  // /cron/:id
  const idMatch = path.match(/^\/cron\/([^/]+)$/)
  if (!idMatch) return false
  const jobId = decodeURIComponent(idMatch[1] ?? "")

  if (req.method === "GET") {
    const job = scheduler.get(jobId)
    if (!job) {
      json(404, { error: "job_not_found", jobId })
      return true
    }
    json(200, job)
    return true
  }

  if (req.method === "DELETE") {
    try {
      scheduler.delete(jobId)
      json(200, { ok: true, jobId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(404, { error: "job_not_found", message: msg })
    }
    return true
  }

  return false
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return null
  }
}
