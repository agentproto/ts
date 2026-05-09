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
    ;(transport as unknown as { onerror?: (e: unknown) => void }).onerror = (
      err: unknown,
    ) => {
      console.error("[mcp transport.onerror]", err)
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
