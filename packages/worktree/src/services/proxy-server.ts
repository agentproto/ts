import http from "node:http"
import { connect as netConnect, type Socket } from "node:net"
import type { ProxyTable } from "./proxy-table.js"

/**
 * A small HTTP reverse proxy over a {@link ProxyTable}. Routes
 * `http://<script>--<branch>--<repo>.localhost:<proxy-port>` to the matched
 * service's local port. Supports WebSocket (and any) `Upgrade` passthrough by
 * splicing raw sockets. Targets are always `127.0.0.1` — services bind
 * locally, the proxy is the only public-ish surface.
 */

const TARGET_HOST = "127.0.0.1"

function notFound(table: ProxyTable, host: string | undefined): string {
  const known = table.entries().map(([h]) => h)
  return (
    `worktree-proxy: no service for host "${host ?? "(none)"}"\n` +
    (known.length ? `known hosts:\n${known.map((h) => `  ${h}`).join("\n")}\n` : "no services registered\n")
  )
}

/** Build (but don't start) the proxy HTTP server backed by `table`. */
export function createProxyServer(table: ProxyTable): http.Server {
  const server = http.createServer((req, res) => {
    const targetPort = table.lookup(req.headers.host)
    if (targetPort === undefined) {
      res.writeHead(502, { "content-type": "text/plain" })
      res.end(notFound(table, req.headers.host))
      return
    }

    const proxyReq = http.request(
      {
        host: TARGET_HOST,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
      res.end(`worktree-proxy: upstream error: ${err.message}\n`)
    })
    req.pipe(proxyReq)
  })

  // WebSocket / generic Upgrade passthrough: splice the client socket to a
  // fresh TCP connection to the target, replaying the original request line
  // and headers so the upstream completes its own handshake.
  server.on("upgrade", (req, clientSocket: Socket, head: Buffer) => {
    const targetPort = table.lookup(req.headers.host)
    if (targetPort === undefined) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      return
    }

    const upstream = netConnect(targetPort, TARGET_HOST, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(headerLines.join("\r\n") + "\r\n\r\n")
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    const teardown = (): void => {
      clientSocket.destroy()
      upstream.destroy()
    }
    upstream.on("error", teardown)
    clientSocket.on("error", teardown)
    upstream.on("close", () => clientSocket.destroy())
    clientSocket.on("close", () => upstream.destroy())
  })

  return server
}

export interface RunningProxy {
  /** The port the proxy is listening on. */
  port: number
  /** The underlying server. */
  server: http.Server
  /** Stop the proxy. */
  close(): Promise<void>
}

/** Start the proxy server on `port` (0 → OS-assigned). Resolves once listening. */
export function startProxy(table: ProxyTable, port = 0): Promise<RunningProxy> {
  const server = createProxyServer(table)
  // Track every accepted socket so shutdown can force-drop them. An upgraded
  // (WebSocket) connection is detached from the server's own tracking, so
  // `server.close()` alone would hang on it — we destroy them explicitly.
  const sockets = new Set<Socket>()
  server.on("connection", (socket: Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => {
      const address = server.address()
      const boundPort = address && typeof address === "object" ? address.port : port
      resolve({
        port: boundPort,
        server,
        close: () =>
          new Promise<void>((res) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => res())
          }),
      })
    })
  })
}
