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

describe("local daemon proxy path filter", () => {
  it("forwards the daemon's own endpoints", async () => {
    for (const path of ["/mcp", "/sessions", "/events", "/sessions/abc/pty"]) {
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
    for (const path of ["/", "/admin", "/mcp-but-not-really", "/../etc/passwd"]) {
      const res = await fetch(`${proxy.url}${path}`)
      expect(res.status).toBe(404)
    }
    expect(upstreamHit).toBe(false)
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
})
