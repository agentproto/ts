import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { startLocalDaemonProxy, type LocalDaemonProxy } from "../local-daemon-proxy.js"

let upstream: Server
let upstreamPort = 0
let proxy: LocalDaemonProxy

const listen = (s: Server): Promise<number> =>
  new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)))

beforeEach(async () => {
  upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ path: req.url }))
  })
  upstreamPort = await listen(upstream)
  proxy = await startLocalDaemonProxy(`http://127.0.0.1:${upstreamPort}/v1/computers/cmp-1/daemon`, {
    "X-Controller-Authorization": "Bearer secret",
  })
})

afterEach(async () => {
  proxy.close()
  upstream.closeAllConnections?.()
  await new Promise((res) => upstream.close(() => res(null)))
})

const proxyPort = (): number => Number(new URL(proxy.url).port)

/** Sends a raw request line over a fresh TCP socket, bypassing the WHATWG
 *  `URL` parser's own `.`/`..` normalization (which `fetch()` would apply
 *  before the request ever reaches the proxy): the only way to actually
 *  exercise an unnormalized path like `/sessions/../../admin`. */
function rawRequest(rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: proxyPort() })
    let buf = ""
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const statusLine = buf.split("\r\n")[0]
      const match = statusLine ? /^HTTP\/1\.1 (\d{3})/.exec(statusLine) : null
      if (match) {
        socket.destroy()
        resolve(Number(match[1]))
      }
    })
    socket.on("error", reject)
    socket.on("connect", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    })
  })
}

describe("local daemon proxy path filter", () => {
  it("forwards the daemon's own endpoints", async () => {
    for (const path of ["/mcp", "/sessions", "/events", "/sessions/abc/pty", "/health"]) {
      const res = await fetch(`${proxy.url}${path}`)
      expect(res.status).toBe(200)
    }
  })

  it("refuses anything else with 404, never reaching upstream", async () => {
    let upstreamHit = false
    upstream.removeAllListeners("request")
    upstream.on("request", (_req, res) => {
      upstreamHit = true
      res.writeHead(200).end()
    })
    for (const path of ["/", "/admin", "/mcp-but-not-really"]) {
      const res = await fetch(`${proxy.url}${path}`)
      expect(res.status).toBe(404)
    }
    expect(upstreamHit).toBe(false)
  })

  it("refuses an unnormalized traversal path, raw on the wire, without ever reaching upstream", async () => {
    let upstreamHit = false
    upstream.removeAllListeners("request")
    upstream.on("request", (_req, res) => {
      upstreamHit = true
      res.writeHead(200).end()
    })
    // fetch()/the WHATWG URL parser would collapse these before they ever
    // left this process, so send them raw to prove the proxy itself
    // refuses what it actually receives on the wire, not what a
    // well-behaved client would have sent.
    expect(await rawRequest("/sessions/../../admin")).toBe(404)
    expect(await rawRequest("/sessions/%2e%2e/%2e%2e/admin")).toBe(404)
    expect(await rawRequest("/sessions/..%2f..%2fadmin")).toBe(404)
    expect(upstreamHit).toBe(false)
  })

  it("collapses a traversal that still resolves inside the allowlist and forwards the resolved path", async () => {
    const seen: string[] = []
    upstream.removeAllListeners("request")
    upstream.on("request", (req, res) => {
      seen.push(req.url ?? "")
      res.writeHead(200).end()
    })
    expect(await rawRequest("/sessions/abc/../def")).toBe(200)
    expect(seen.at(-1)).toBe("/v1/computers/cmp-1/daemon/sessions/def")
  })

  it("forwards extra headers (the session holder) on both the HTTP and the upgrade leg", async () => {
    proxy = await startLocalDaemonProxy(`http://127.0.0.1:${upstreamPort}/v1/computers/cmp-1/daemon`, {
      "X-Controller-Authorization": "Bearer secret",
      "X-Computer-Session-Holder": "sess_holder_1",
    })
    let httpHeaders: IncomingMessage["headers"] | undefined
    let upgradeHeaders: IncomingMessage["headers"] | undefined
    upstream.removeAllListeners("request")
    upstream.on("request", (req, res) => {
      httpHeaders = req.headers
      res.writeHead(200).end()
    })
    const res = await fetch(`${proxy.url}/mcp`)
    expect(res.status).toBe(200)
    expect(httpHeaders?.["x-computer-session-holder"]).toBe("sess_holder_1")
    expect(httpHeaders?.["x-controller-authorization"]).toBe("Bearer secret")
    await new Promise<void>((resolve) => {
      upstream.once("upgrade", (req, socket) => {
        upgradeHeaders = req.headers
        socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
        socket.on("error", () => undefined)
        socket.destroy()
        resolve()
      })
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort(),
        path: "/sessions/abc/pty",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })
      req.on("response", (r) => {
        r.resume()
        resolve()
      })
      req.on("error", () => resolve())
      req.end()
    })
    expect(upgradeHeaders?.["x-computer-session-holder"]).toBe("sess_holder_1")
  })

  it("applies the same filter to a WebSocket upgrade", async () => {
    const upgrade = (path: string): Promise<number> =>
      new Promise((resolve) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: proxyPort(),
          path,
          headers: { connection: "Upgrade", upgrade: "websocket" },
        })
        req.on("upgrade", (res: IncomingMessage, clientSocket: Socket) => {
          clientSocket.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.on("response", (res: IncomingMessage) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on("error", () => resolve(0))
        req.end()
      })
    let upstreamSocket: Duplex | undefined
    upstream.on("upgrade", (_req, socket) => {
      upstreamSocket = socket
      socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
      socket.on("error", () => undefined)
    })
    expect(await upgrade("/sessions/abc/pty")).toBe(101)
    // Node's http server stops tracking a connection once it has been
    // upgraded (handed off from the request path), so closeAllConnections
    // in afterEach never sees it: destroy it explicitly.
    upstreamSocket?.destroy()
    expect(await upgrade("/nope")).toBe(404)
  })
})

describe("local daemon proxy teardown", () => {
  it("close() drops an open keep-alive connection instead of waiting for it to idle out", async () => {
    const socket: Socket = connect({ host: "127.0.0.1", port: proxyPort() })
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    socket.write("GET /mcp HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n")
    await new Promise<void>((resolve) => socket.once("data", () => resolve()))
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    proxy.close()
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("socket was not closed promptly")), 500)),
    ])
  })

  it("close() also terminates a live /sessions/:id/pty upgrade, both the client and the upstream leg", async () => {
    let upstreamSocket: Duplex | undefined
    upstream.on("upgrade", (_req, socket) => {
      upstreamSocket = socket
      socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
      socket.on("error", () => undefined)
      // A real peer closes its own side once it sees the other end go
      // away; without this the raw socket stays half-open (readable end
      // only) and never reaches 'close' itself, even though the proxy's
      // own leg was correctly torn down.
      socket.on("end", () => socket.destroy())
    })
    const clientSocket = await new Promise<Socket>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort(),
        path: "/sessions/abc/pty",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })
      req.on("upgrade", (_res: IncomingMessage, socket: Socket) => resolve(socket))
      req.on("error", reject)
      req.end()
    })
    const clientClosed = new Promise<void>((resolve) => clientSocket.once("close", () => resolve()))
    const upstreamClosed = new Promise<void>((resolve) => {
      if (upstreamSocket?.destroyed) {
        resolve()
        return
      }
      upstreamSocket?.once("close", () => resolve())
    })
    proxy.close()
    await Promise.race([
      Promise.all([clientClosed, upstreamClosed]),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("upgraded sockets were not closed promptly")), 500)),
    ])
  })
})
