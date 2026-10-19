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
// these: "/mcp · /sessions · /events · /sessions/:id/pty (WS)"), plus the
// in-box health probe other callers derive from an mcpUrl by convention
// (see e.g. packages/workspace-brain/src/provider-resolver.ts). Anything
// else reaching this loopback port is not a request this proxy's caller
// would ever send, so it is refused here rather than forwarded upstream
// with the controller credential attached.
const ALLOWED_PATH_RE = /^\/(mcp|sessions|events|health)(?:\/|$)/

/** Decodes and collapses `.`/`..` segments so the allowlist check and the
 *  forwarded path both see where the request actually resolves to: a raw
 *  `/sessions/../../admin` (or its `%2e%2e`-encoded form) must not slip
 *  past the allowlist as an unresolved string and then get forwarded
 *  verbatim with the controller credential attached: whether the HTTP
 *  client or the controller happens to normalize it before routing is not
 *  something this proxy can assume. Returns `undefined` for anything
 *  malformed or that tries to climb above the root. */
function resolveRequestPath(rawUrl: string | undefined): { path: string; search: string } | undefined {
  if (!rawUrl) return undefined
  const qIndex = rawUrl.indexOf("?")
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex)
  const search = qIndex === -1 ? "" : rawUrl.slice(qIndex)
  // Decode the WHOLE path before splitting (not segment by segment): a
  // percent-encoded slash (`%2f`) is a path separator here too, exactly
  // like a literal one: treating it as opaque content inside one segment
  // would let `..%2f..%2fadmin` round-trip straight through unresolved.
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  const segments: string[] = []
  for (const segment of decodedPath.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { path: `/${segments.map(encodeURIComponent).join("/")}`, search }
}

/** Starts the proxy: every allowed request to `url` is forwarded to
 *  `remoteBase` with `extraHeaders` merged in; the caller's own headers
 *  (notably `Authorization`, which carries the box's per-box daemon token)
 *  pass through untouched. */
export async function startLocalDaemonProxy(
  remoteBase: string,
  extraHeaders: Record<string, string>
): Promise<LocalDaemonProxy> {
  const target = new URL(remoteBase)
  // Upgraded (WebSocket) sockets are handed off by Node's http server the
  // moment the 'upgrade' event fires, so `server.closeAllConnections()`
  // never sees them: track both ends of every piped upgrade ourselves so
  // `close()` can actually terminate a live /sessions/:id/pty tunnel
  // instead of leaving it (and the controller credential its upstream leg
  // was opened with) running past teardown.
  const openUpgrades = new Set<Duplex>()
  const server: Server = createServer((req, res) => {
    const resolved = resolveRequestPath(req.url)
    if (!resolved || !ALLOWED_PATH_RE.test(resolved.path)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
      return
    }
    forwardHttp(req, res, target, extraHeaders, resolved)
  })
  server.on("upgrade", (req, socket, head) => {
    const resolved = resolveRequestPath(req.url)
    if (!resolved || !ALLOWED_PATH_RE.test(resolved.path)) {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
      return
    }
    forwardUpgrade(req, socket, head, target, extraHeaders, resolved, openUpgrades)
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
      // keep-alive HTTP sockets right away instead of leaving them to idle
      // out (Node's default keep-alive timeout is 5s); the upgraded-socket
      // set covers what that call cannot reach.
      server.close()
      server.closeAllConnections()
      for (const socket of openUpgrades) socket.destroy()
      openUpgrades.clear()
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

function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  extraHeaders: Record<string, string>,
  resolved: { path: string; search: string }
): void {
  const request = target.protocol === "https:" ? httpsRequest : httpRequest
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname.replace(/\/+$/, "")}${resolved.path}${resolved.search}`,
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
  extraHeaders: Record<string, string>,
  resolved: { path: string; search: string },
  tracked: Set<Duplex>
): void {
  const isTls = target.protocol === "https:"
  const port = Number(target.port) || (isTls ? 443 : 80)
  const upstream: Socket | TLSSocket = isTls
    ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
    : netConnect({ host: target.hostname, port })
  // The client socket is already handed off by the HTTP server at this
  // point (before the upstream TCP/TLS handshake even completes), so this
  // is the only chance for close() to reach it: tracking inside the
  // connect callback leaves a window, between this call and that callback,
  // where close() finds nothing to destroy.
  tracked.add(socket)
  tracked.add(upstream)
  const teardown = (): void => {
    upstream.destroy()
    socket.destroy()
  }
  const forget = (): void => {
    tracked.delete(socket)
    tracked.delete(upstream)
  }
  upstream.once("error", teardown)
  socket.once("error", teardown)
  socket.once("close", () => {
    upstream.destroy()
    forget()
  })
  upstream.once("close", () => {
    socket.destroy()
    forget()
  })
  upstream.once(isTls ? "secureConnect" : "connect", () => {
    // A close() that ran during the handshake already destroyed both ends:
    // piping now would resurrect the tunnel past teardown.
    if (socket.destroyed || upstream.destroyed) {
      upstream.destroy()
      socket.destroy()
      return
    }
    const path = `${target.pathname.replace(/\/+$/, "")}${resolved.path}${resolved.search}`
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
