/**
 * Tests for the narrow public ingress proxy (telegram-proxy.ts).
 *
 * SECURITY: prove it forwards POST /inbound/* and rejects everything else,
 * including sneaky paths like /inbound/../sessions/foo.
 */

import { describe, expect, it } from "vitest"
import { createServer, request, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { createTelegramProxy } from "../telegram-proxy.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function withTargetAndProxy(
  fn: (opts: {
    proxyBase: string
    targetBase: string
    recorded: RecordedRequest[]
  }) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = []
  const targetPort = await freePort()

  const targetServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      recorded.push({
        method: req.method ?? "UNKNOWN",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, received: body }))
    })
  })

  await new Promise<void>(resolve =>
    targetServer.listen(targetPort, "127.0.0.1", resolve),
  )
  const targetBase = `http://127.0.0.1:${targetPort}`

  const proxyPort = await freePort()
  const proxy = createTelegramProxy({
    targetBaseUrl: targetBase,
    listenPort: proxyPort,
  })

  const { url: proxyBase } = await proxy.start()

  try {
    await fn({ proxyBase, targetBase, recorded })
  } finally {
    await proxy.stop()
    await new Promise<void>(resolve => targetServer.close(() => resolve()))
  }
}

describe("createTelegramProxy", () => {
  it("forwards POST /inbound/foo with body and headers", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound/foo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-custom": "hello",
        },
        body: JSON.stringify({ text: "hello world" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ok: true,
        received: JSON.stringify({ text: "hello world" }),
      })

      expect(recorded).toHaveLength(1)
      expect(recorded[0]!).toMatchObject({
        method: "POST",
        url: "/inbound/foo",
        body: JSON.stringify({ text: "hello world" }),
      })
      expect(recorded[0]!.headers["x-custom"]).toBe("hello")
    })
  })

  it("preserves query strings", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound/foo?bar=baz&qux=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)

      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.url).toBe("/inbound/foo?bar=baz&qux=1")
    })
  })

  it("returns 405 for GET /inbound/foo", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound/foo`, { method: "GET" })
      expect(res.status).toBe(405)
      expect(await res.json()).toEqual({ error: "method_not_allowed" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("returns 404 for POST /sessions/foo", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/sessions/foo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("returns 404 for POST /", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("returns 404 for POST /inbound (no trailing slash)", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("blocks path traversal /inbound/../sessions/foo", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound/../sessions/foo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("blocks percent-encoded path traversal /inbound/%2E%2E/sessions/foo", async () => {
    await withTargetAndProxy(async ({ proxyBase, recorded }) => {
      const res = await fetch(`${proxyBase}/inbound/%2E%2E/sessions/foo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect(recorded).toHaveLength(0)
    })
  })

  it("listens on the configured port and reports URL", async () => {
    const targetPort = await freePort()
    const targetServer = createServer((req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    await new Promise<void>(resolve =>
      targetServer.listen(targetPort, "127.0.0.1", resolve),
    )

    const proxyPort = await freePort()
    const proxy = createTelegramProxy({
      targetBaseUrl: `http://127.0.0.1:${targetPort}`,
      listenPort: proxyPort,
    })

    const { url, port } = await proxy.start()
    expect(port).toBe(proxyPort)
    expect(url).toBe(`http://127.0.0.1:${proxyPort}`)

    await proxy.stop()
    await new Promise<void>(resolve => targetServer.close(() => resolve()))
  })

  it("does not follow redirects — passes upstream redirect through", async () => {
    const targetPort = await freePort()
    const targetServer = createServer((req, res) => {
      res.writeHead(301, { location: "http://example.com/elsewhere" })
      res.end()
    })
    await new Promise<void>(resolve =>
      targetServer.listen(targetPort, "127.0.0.1", resolve),
    )

    const proxyPort = await freePort()
    const proxy = createTelegramProxy({
      targetBaseUrl: `http://127.0.0.1:${targetPort}`,
      listenPort: proxyPort,
    })
    await proxy.start()

    try {
      // Use node:http.request directly so Node's fetch doesn't follow the redirect.
      const res = await new Promise<{
        status: number
        location: string | null
      }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: "/inbound/foo",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          incoming => {
            resolve({
              status: incoming.statusCode ?? 0,
              location: incoming.headers["location"] ?? null,
            })
          },
        )
        req.on("error", reject)
        req.write(JSON.stringify({}))
        req.end()
      })

      expect(res.status).toBe(301)
      expect(res.location).toBe("http://example.com/elsewhere")
    } finally {
      await proxy.stop()
      await new Promise<void>(resolve => targetServer.close(() => resolve()))
    }
  })

  it("returns 502 when upstream is unreachable", async () => {
    const proxyPort = await freePort()
    const proxy = createTelegramProxy({
      targetBaseUrl: "http://127.0.0.1:1", // nothing listening here
      listenPort: proxyPort,
    })
    await proxy.start()

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/inbound/foo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "bad_gateway" })
    } finally {
      await proxy.stop()
    }
  })
})
