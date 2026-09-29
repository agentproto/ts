import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { createServer, type Server, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateIdentity } from "@agentproto/secrets/identity"
import { createPairingRegistry, serveLoopbackHttp, type ServeLoopbackHttpOptions } from "../index.js"
import { FakeRendezvous, pairViaOffer } from "./fixtures.js"

interface Seen {
  path: string
  headers: IncomingHttpHeaders
}

describe("serveLoopbackHttp", () => {
  let tmp: string
  let upstream: Server
  let upstreamUrl: URL
  let seen: Seen[]
  const closers: Array<() => Promise<void>> = []

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-host-http-"))
    seen = []
    upstream = createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers })
      res.setHeader("content-type", "text/plain")
      res.end(`hello from ${req.url}`)
    })
    await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r))
    upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)
  })
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => {})
    await new Promise<void>(r => upstream.close(() => r()))
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  async function pairedClient(opts: Partial<ServeLoopbackHttpOptions>) {
    const rv = new FakeRendezvous()
    const identity = await generateIdentity()
    const registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: rv.dial,
      serve: serveLoopbackHttp({ target: upstreamUrl, ...opts }),
      handshakeTimeoutMs: 5_000,
    })
    closers.push(() => registry.shutdown())
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "agent")
    closers.push(() => client.close())
    await client.ready()
    return client
  }

  it("forwards a request with the injected header, overriding the client's", async () => {
    const client = await pairedClient({
      injectHeaders: { authorization: "Bearer host-secret" },
      allowPaths: ["/mcp", "/api/*"],
    })
    const res = await client.forwardHttp({
      method: "GET",
      path: "/mcp?x=1",
      headers: { authorization: "Bearer client-supplied", "x-keep": "yes" },
    })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe("hello from /mcp?x=1")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.headers.authorization).toBe("Bearer host-secret")
    expect(seen[0]?.headers["x-keep"]).toBe("yes")

    const nested = await client.forwardHttp({ method: "GET", path: "/api/v1/things" })
    expect(nested.status).toBe(200)
  })

  it("refuses paths outside allowPaths without reaching the target", async () => {
    const client = await pairedClient({ allowPaths: ["/mcp"] })
    for (const path of ["/admin", "/mcp/extra", "/mcpx", "/mcp/%2e%2e/admin", "//evil"]) {
      const res = await client.forwardHttp({ method: "GET", path })
      expect(res.status, path).not.toBe(200)
    }
    const denied = await client.forwardHttp({ method: "GET", path: "/admin" })
    expect(denied.status).toBe(403)
    expect(seen).toHaveLength(0)

    const ok = await client.forwardHttp({ method: "GET", path: "/mcp" })
    expect(ok.status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it("rejects a non-loopback or non-http target at construction", () => {
    expect(() => serveLoopbackHttp({ target: "http://example.com" })).toThrow(/loopback/)
    expect(() => serveLoopbackHttp({ target: "ftp://127.0.0.1" })).toThrow(/http/)
  })
})
