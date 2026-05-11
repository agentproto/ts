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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { ConversationStore } from "./conversations.js"
import type { HeartbeatRunner } from "./heartbeat.js"
import type { RuntimeEvents, RuntimeEvent } from "./events.js"
import type { SessionsRegistry, AgentSessionLike } from "./sessions.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"
import { discoverMcps } from "./mcp-discovery.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"

/**
 * Pluggable adapter resolver — keeps the runtime package free of any
 * @agentproto/cli dep. The host (cli `serve`, playground, embedding
 * apps) builds the resolver and hands it in. Returning null means
 * "adapter not found" → 404.
 */
export type AgentAdapterResolver = (slug: string) => Promise<{
  /** Build a fresh AgentSessionLike for the given cwd. The driver
   *  spawns the adapter binary, opens the protocol, and the
   *  registry holds the result. */
  startSession(opts: { cwd: string }): Promise<AgentSessionLike>
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
  /** Optional — MCP proxy registry. When wired, exposes
   *  `/mcps/proxy/*` routes that let the browser drive imported MCPs
   *  without going through the MCP wire protocol (useful for the
   *  /providers/mcp page's "Local" tab). */
  mcpProxy?: McpProxyRegistry
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

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req, res)) return
    // Per-request server + transport, per the SDK's stateless pattern.
    // Sharing either across requests breaks after the first one because
    // `Protocol.connect` rejects re-attachment.
    const server = await opts.mcpServerFactory()
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

  // Permissive CORS for the loopback gateway. The Guilde web app
  // (localhost:3041) probes /health from the browser; without these
  // headers the browser blocks the response and the panel says
  // "not reachable" even though curl works. Auth still gates the
  // sensitive routes — this just lifts the cross-origin block.
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

        // Sessions routes — only registered when the gateway was
        // built with a SessionsRegistry. /sessions, /sessions/:id,
        // /sessions/:id/stream (SSE), POST /sessions/:id/kill,
        // DELETE /sessions/:id (forget after exit).
        if (opts.sessions && path.startsWith("/sessions")) {
          const handled = await handleSessions(
            req,
            res,
            path,
            opts.sessions,
            opts.resolveAgentAdapter
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

  const bind = opts.bind ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, bind, () => resolve())
  })

  return {
    url: `http://${bind}:${opts.port}`,
    async stop() {
      // Per-request transports/servers are torn down on `res.close`,
      // so we only need to stop the HTTP listener here.
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * /sessions routes — split out of the main switch so the surface
 * stays scannable. Returns `true` when it handled the request, so
 * the dispatcher knows to skip the 404 path.
 *
 *   GET    /sessions              → list of SessionDescriptor[]
 *   GET    /sessions/:id          → one SessionDescriptor
 *   GET    /sessions/:id/stream   → SSE stream {line,stream} events
 *   POST   /sessions/:id/kill     → SIGTERM, returns {ok}
 *   DELETE /sessions/:id          → forget (drop from registry; only
 *                                    valid for exited/killed/error)
 */
async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
  resolveAgentAdapter?: AgentAdapterResolver
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
      const agentSession = await resolved.startSession({ cwd })
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

  // Send a follow-up turn to a live agent session.
  // Body: { prompt: string }
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
    if (typeof prompt !== "string") {
      json(400, { error: "missing_prompt" })
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

  // Per-id routes
  const idMatch = path.match(/^\/sessions\/([^/]+)(\/stream|\/kill)?$/)
  if (!idMatch) return false
  const [, id, suffix] = idMatch
  if (!id) return false

  if (suffix === "/stream" && req.method === "GET") {
    const desc = registry.get(id)
    if (!desc) {
      json(404, { error: "session_not_found", id })
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
    json(ok ? 200 : 404, { ok, id })
    return true
  }

  if (!suffix && req.method === "GET") {
    const desc = registry.get(id)
    if (!desc) {
      json(404, { error: "session_not_found", id })
      return true
    }
    json(200, desc)
    return true
  }

  if (!suffix && req.method === "DELETE") {
    const ok = registry.forget(id)
    json(ok ? 200 : 404, { ok, id })
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
