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
import type { TunnelRegistry } from "./tunnel-registry.js"
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
    /** Model identifier forwarded from `start_agent_session`. For ACP
     *  adapters this is applied via session/set_config_option after
     *  newSession (the ACP wrapper does not forward CLI args to claude).
     *  Adapters that don't support model selection ignore it. */
    model?: string
    /** Effort level forwarded from `start_agent_session`. Effort is
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
  }): Promise<AgentSessionLike>
  /** Display label for the descriptor's `command` field. */
  commandPreview?: string
} | null>

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
   */
  mcpServerFactory: () => Promise<McpServer>
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
  /** Optional — when wired, enables `GET /adapters` route + the
   *  MCP `list_adapters` tool so UIs can discover what's installed
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
  /** Static fields surfaced via `/health`. */
  meta: {
    workspace: string
    registered: readonly string[]
  }
}

export interface RuntimeHttpServerHandle {
  url: string
  stop(): Promise<void>
}

export async function startHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const startedAt = Date.now()
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

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req, res)) return
    const server = await opts.mcpServerFactory()
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
      .replace(/[ /\\]/g, "_")
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

        // Tunnel routes — only registered when the gateway was built with
        // a TunnelRegistry. /tunnels, /tunnels/:id.
        if (opts.tunnels && path.startsWith("/tunnels")) {
          const handled = await handleTunnels(req, res, path, opts.tunnels)
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
 *   POST   /sessions/:id/kill     → SIGTERM, returns {ok}
 *   DELETE /sessions/:id          → forget (drop from registry; only
 *                                    valid for exited/killed/error)
 *   POST   /sessions/browser      → start a browser adapter and register
 *                                    as a tracked session; body:
 *                                    { adapter, port?, camofoxPort?, label? }
 *                                    (requires `resolveBrowserAdapter` wired)
 */
async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
  resolveAgentAdapter?: AgentAdapterResolver,
  ptyEnabled = false,
  resolveBrowserAdapter?: BrowserAdapterResolver,
  listBrowserAdapters?: BrowserAdapterLister,
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
  //    workspaceSlug, cwd, prompt?, label?}
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
    // cwd resolution priority:
    //   1. explicit `cwd` in the body
    //   2. lookup `workspaceSlug` in ~/.agentproto/workspaces.json
    //   3. active workspace from the same config
    //   4. process.cwd() (last resort, almost certainly not what
    //      the user wants — log it so the operator notices)
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
        // Config missing / unreadable — fall through to process.cwd()
      }
    }
    if (!cwd) {
      cwd = process.cwd()
      console.warn(
        `[/sessions/agent] no cwd resolvable for adapter=${adapter} ` +
          `(no body.cwd, no workspaceSlug match in ~/.agentproto/workspaces.json, ` +
          `no active workspace) — falling back to daemon's cwd ${cwd}`
      )
    }
    if (!workspaceSlug) workspaceSlug = "default"
    const resolved = await resolveAgentAdapter(adapter)
    if (!resolved) {
      json(404, { error: "adapter_not_found", adapter })
      return true
    }
    try {
      const resumeSessionId =
        typeof b.resumeSessionId === "string" && b.resumeSessionId.length > 0
          ? b.resumeSessionId
          : undefined
      const bodyModel = typeof b.model === "string" && b.model.length > 0
        ? b.model
        : undefined
      const bodyEffort = typeof b.effort === "string" && b.effort.length > 0
        ? b.effort
        : undefined
      const agentSession = await resolved.startSession({
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(bodyModel ? { model: bodyModel } : {}),
        ...(bodyEffort ? { effort: bodyEffort } : {}),
      })
      const desc = registry.spawnAgent({
        workspaceSlug,
        cwd,
        agentSession,
        adapterSlug: adapter,
        ...(typeof b.prompt === "string" ? { initialPrompt: b.prompt } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
        ...(resolved.commandPreview
          ? { commandPreview: resolved.commandPreview }
          : {}),
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "agent_spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Browser service session — start the adapter and register as a tracked
  // session. HTTP equivalent of the MCP `start_browser` tool.
  // Body: { adapter: string, port?: number, camofoxPort?: number, label?: string }
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
    try {
      const instance = await adapter.ensure({
        port: typeof b.port === "number" ? b.port : undefined,
        camofoxPort: typeof b.camofoxPort === "number" ? b.camofoxPort : undefined,
        initialWaitMs: 6_000,
      })
      const desc = registry.registerBrowser({
        adapterId: instance.id,
        port: instance.port,
        baseUrl: instance.baseUrl,
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
  // Body: { prompt: string | ContentBlock | ContentBlock[] }
  //   - string                → auto-wrapped to a single text block by
  //                             the registry (legacy / convenience).
  //   - ContentBlock          → e.g. `{type:"image", source:{...}}`
  //   - ContentBlock[]        → text + image mix for multimodal turns.
  //                             Forwarded as-is to `agentSession.send`
  //                             so the adapter (claude-agent-acp, …)
  //                             negotiates its own content shape.
  //
  // Validation is intentionally loose — we accept anything object-
  // shaped + non-empty arrays + non-empty strings. The adapter will
  // reject ill-formed blocks with a clear error projected into the
  // session's ring buffer; throwing here would just duplicate that.
  //
  // Query: ?wait=false → fire-and-forget (return 202 after sync
  //   validation; output streams via /sessions/:id/stream). Default
  //   wait=true keeps the call blocking until the turn drains, which
  //   is what curl scripts + the MCP bridge expect.
  const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompt$/)
  if (promptMatch && req.method === "POST") {
    const id = promptMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const prompt = (body as { prompt?: unknown } | null)?.prompt
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
        registry.enqueuePrompt(id, prompt)
        json(202, { ok: true, id, queued: true })
      } else {
        await registry.sendPrompt(id, prompt)
        json(200, { ok: true, id })
      }
    } catch (err) {
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
    /^\/sessions\/([^/]+)(\/stream|\/kill|\/preview|\/export)?$/,
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
    const result = await exportAgentSession({
      sessionId: rawIdOrName,
      registry,
      format: fmt,
      ...(adapterOverride ? { adapter: adapterOverride } : {}),
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
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
        ...(b.provider === "quick" || b.provider === "named"
          ? { provider: b.provider }
          : {}),
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
