import { describe, it, expect, afterEach } from "vitest"
import http from "node:http"
import { ProxyTable } from "../services/proxy-table.js"
import { startProxy, type RunningProxy } from "../services/proxy-server.js"

/** Spin up a trivial origin server that echoes its name + path. */
function startOrigin(name: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") return
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`${name}:${req.url}:host=${req.headers.host ?? ""}`)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

async function get(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = ""
      res.on("data", (d) => (body += d))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("reverse proxy routing", () => {
  const closers: Array<() => Promise<void>> = []
  let proxy: RunningProxy | undefined

  afterEach(async () => {
    if (proxy) await proxy.close()
    proxy = undefined
    while (closers.length) await closers.pop()!()
  })

  it("routes each host to its registered origin, preserving path + Host", async () => {
    const web = await startOrigin("web")
    const api = await startOrigin("api")
    closers.push(web.close, api.close)

    const table = new ProxyTable()
    table.set("web--repo.localhost", web.port)
    table.set("api--repo.localhost", api.port)
    proxy = await startProxy(table, 0)

    const r1 = await get(proxy.port, "web--repo.localhost", "/hello")
    expect(r1.status).toBe(200)
    expect(r1.body).toBe("web:/hello:host=web--repo.localhost")

    const r2 = await get(proxy.port, "api--repo.localhost:" + proxy.port, "/status")
    expect(r2.status).toBe(200)
    expect(r2.body).toBe("api:/status:host=api--repo.localhost:" + proxy.port)
  })

  it("returns 502 for an unknown host", async () => {
    const table = new ProxyTable()
    proxy = await startProxy(table, 0)
    const r = await get(proxy.port, "ghost.localhost")
    expect(r.status).toBe(502)
    expect(r.body).toContain("no service for host")
  })

  it("passes a raw Upgrade handshake through to the origin", async () => {
    // A minimal origin that completes a WebSocket-style upgrade by hand and
    // echoes one frame of bytes back, proving the proxy splices the socket.
    const upstream = http.createServer()
    const upSockets = new Set<import("node:net").Socket>()
    upstream.on("connection", (s) => {
      upSockets.add(s)
      s.once("close", () => upSockets.delete(s))
    })
    upstream.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      )
      socket.on("data", (chunk) => socket.write(chunk)) // echo
    })
    const upPort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const addr = upstream.address()
        resolve(addr && typeof addr === "object" ? addr.port : 0)
      })
    })
    closers.push(
      () =>
        new Promise<void>((r) => {
          for (const s of upSockets) s.destroy()
          upstream.close(() => r())
        }),
    )

    const table = new ProxyTable()
    table.set("ws--repo.localhost", upPort)
    proxy = await startProxy(table, 0)

    const result = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy!.port,
        path: "/socket",
        headers: {
          host: "ws--repo.localhost",
          Connection: "Upgrade",
          Upgrade: "websocket",
        },
      })
      req.on("upgrade", (res, socket) => {
        expect(res.statusCode).toBe(101)
        socket.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("utf8"))
          socket.destroy()
        })
        socket.write("ping")
      })
      req.on("error", reject)
      req.end()
    })
    expect(result).toBe("ping")
  })
})
