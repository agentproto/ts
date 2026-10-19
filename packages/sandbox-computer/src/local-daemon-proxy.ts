/**
 * Loopback-only reverse proxy used in `daemonRoute` mode: it is the ONE
 * place the controller's tenant-wide bearer and the edge Access headers are
 * attached, so they never have to leave this process. `BootedSandbox` hands
 * the caller `http://127.0.0.1:<port>` (and an `authHeaders` carrying only
 * the box's own per-box daemon token) instead of the real
 * `<controllerUrl>/v1/computers/:id/daemon` URL plus the controller
 * credential — a caller that persists `mcpUrl`/`authHeaders` (a session
 * descriptor, a paste-ready `.mcp.json`) can therefore never leak a
 * credential that reaches every computer under the tenant.
 *
 * Bound to 127.0.0.1 on an ephemeral port: unreachable off this host, same
 * trust boundary as the box's own gated daemon bearer.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect, type TLSSocket } from "node:tls"
import type { Duplex } from "node:stream"
import type { AddressInfo } from "node:net"

export interface LocalDaemonProxy {
  /** `http://127.0.0.1:<port>` */
  url: string
  close(): void
}

const STRIPPED_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "content-length"])

// The agentproto daemon's own HTTP surface (its startup banner lists exactly
// these: "/mcp · /sessions · /events · /sessions/:id/pty (WS)"). Anything
// else reaching this loopback port is not a request this proxy's one caller
// (connectDaemonAgentSessionHost, handed only `mcpUrl`) would ever send, so
// it is refused here rather than forwarded upstream with the controller
// credential attached.
const ALLOWED_PATH_RE = /^\/(mcp|sessions|events)(?:[/?]|$)/

function isAllowedPath(url: string | undefined): boolean {
  if (!url) return false
  return ALLOWED_PATH_RE.test(url.split("?")[0] ?? "")
}

/** Starts the proxy: every request to `url` is forwarded to `remoteBase`
 *  (same path and query) with `extraHeaders` merged in; the caller's own
 *  headers (notably `Authorization`, which carries the box's per-box
 *  daemon token) pass through untouched. */
export async function startLocalDaemonProxy(
  remoteBase: string,
  extraHeaders: Record<string, string>
): Promise<LocalDaemonProxy> {
  const target = new URL(remoteBase)
  const server: Server = createServer((req, res) => {
    if (!isAllowedPath(req.url)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
      return
    }
    forwardHttp(req, res, target, extraHeaders)
  })
  server.on("upgrade", (req, socket, head) => {
    if (!isAllowedPath(req.url)) {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
      return
    }
    forwardUpgrade(req, socket, head, target, extraHeaders)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      // Deterministic teardown: closeAllConnections drops any open
      // keep-alive sockets right away instead of leaving them to idle out
      // (Node's default keep-alive timeout is 5s), so a caller that awaits
      // the box's own stop()/pause() never has a lingering local listener.
      server.close()
      server.closeAllConnections()
    },
  }
}

function mergedHeaders(
  incoming: IncomingMessage["headers"],
  extraHeaders: Record<string, string>,
  // An upgrade handshake needs its own `connection: Upgrade`: stripping it
  // (as forwardHttp must, to let the upstream client set its own framing)
  // would stop the upstream daemon from ever recognizing the request as an
  // upgrade at all.
  keepConnectionHeader = false
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(incoming)) {
    const low = k.toLowerCase()
    if (v === undefined) continue
    if (STRIPPED_REQUEST_HEADERS.has(low) && !(keepConnectionHeader && low === "connection")) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extraHeaders)) out[k] = v
  return out
}

function forwardHttp(req: IncomingMessage, res: ServerResponse, target: URL, extraHeaders: Record<string, string>): void {
  const request = target.protocol === "https:" ? httpsRequest : httpRequest
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname.replace(/\/+$/, "")}${req.url ?? ""}`,
      method: req.method,
      headers: { ...mergedHeaders(req.headers, extraHeaders), host: target.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    }
  )
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "daemon unreachable" }))
  })
  req.pipe(upstream)
}

function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
  extraHeaders: Record<string, string>
): void {
  const isTls = target.protocol === "https:"
  const port = Number(target.port) || (isTls ? 443 : 80)
  const upstream: Socket | TLSSocket = isTls
    ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
    : netConnect({ host: target.hostname, port })
  const teardown = (): void => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.once("error", teardown)
  socket.once("error", teardown)
  socket.once("close", () => upstream.destroy())
  upstream.once("close", () => socket.destroy())
  upstream.once(isTls ? "secureConnect" : "connect", () => {
    const path = `${target.pathname.replace(/\/+$/, "")}${req.url ?? ""}`
    const lines = [`${req.method ?? "GET"} ${path} HTTP/1.1`, `host: ${target.host}`]
    const headers = mergedHeaders(req.headers, extraHeaders, true)
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "host") continue
      const values = Array.isArray(v) ? v : [v]
      for (const value of values) lines.push(`${k}: ${value}`)
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
}
