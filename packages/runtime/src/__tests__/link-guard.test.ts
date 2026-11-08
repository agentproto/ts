import { afterEach, describe, expect, it } from "vitest"
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http"
import { createLinkGuard, parseTtlMs, COOKIE_NAME, DEFAULT_TTL_MS } from "../remote-providers/link-guard.js"
import { PUBLIC_BASE_HEADER, resolvePublicBase, signPublicBase } from "../public-origins.js"

/** GET with a caller-chosen Host (fetch cannot set it). Resolves the target's echoed headers. */
function echoHeaders(port: number, headers: Record<string, string>): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/echo-headers", headers }, res => {
      const chunks: Buffer[] = []
      res.on("data", c => chunks.push(c as Buffer))
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as IncomingHttpHeaders))
    })
    req.on("error", reject)
    req.end()
  })
}

/** A tiny real HTTP target the guard proxies to — a Vite-shaped dev server
 *  stand-in: a normal page plus the two paths the guard must block. */
function startTarget(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/@fs/etc/passwd") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("root:x:0:0")
      return
    }
    if (req.url === "/app.js.map") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"version":3}')
      return
    }
    if (req.url === "/echo-headers") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(req.headers))
      return
    }
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<html>hello ${req.url}</html>`)
  })
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      resolve({ server, port })
    })
  })
}

function readSetCookie(res: Response): string | undefined {
  // undici Headers doesn't expose multi-value set-cookie via get(); a
  // single Set-Cookie (our only one) still comes through get() fine.
  return res.headers.get("set-cookie") ?? undefined
}

describe("parseTtlMs", () => {
  it("parses unit suffixes", () => {
    expect(parseTtlMs("90000ms")).toBe(90_000)
    expect(parseTtlMs("90s")).toBe(90_000)
    expect(parseTtlMs("5m")).toBe(5 * 60_000)
    expect(parseTtlMs("2h")).toBe(2 * 3_600_000)
    expect(parseTtlMs("7d")).toBe(7 * 86_400_000)
  })

  it("defaults to 24h when absent or unparsable", () => {
    expect(parseTtlMs(undefined)).toBe(DEFAULT_TTL_MS)
    expect(parseTtlMs("")).toBe(DEFAULT_TTL_MS)
    expect(parseTtlMs("banana")).toBe(DEFAULT_TTL_MS)
    expect(parseTtlMs("-5m")).toBe(DEFAULT_TTL_MS)
  })

  it("clamps to [1min, 30d]", () => {
    expect(parseTtlMs("1ms")).toBe(60_000)
    expect(parseTtlMs("365d")).toBe(30 * 86_400_000)
  })
})

describe("createLinkGuard", () => {
  let target: { server: Server; port: number } | undefined
  let guardStop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await guardStop?.()
    guardStop = undefined
    if (target) {
      await new Promise<void>(resolve => target!.server.close(() => resolve()))
      target = undefined
    }
  })

  async function setup(ttlMs?: number) {
    target = await startTarget()
    const guard = createLinkGuard({ target: { host: "127.0.0.1", port: target.port }, ttlMs })
    const handle = await guard.start()
    guardStop = () => guard.stop()
    return { guard, handle, base: `http://127.0.0.1:${handle.port}` }
  }

  it("rejects a request with no token and no cookie", async () => {
    const { base } = await setup()
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(403)
    expect(res.headers.get("x-robots-tag")).toBe("noindex")
  })

  it("rejects an invalid token", async () => {
    const { base } = await setup()
    const res = await fetch(`${base}/?t=not-the-real-token`)
    expect(res.status).toBe(403)
  })

  it("a valid token redirects, sets a cookie, and strips the token from the Location", async () => {
    const { base, handle } = await setup()
    const res = await fetch(`${base}/some/path?t=${handle.token}`, { redirect: "manual" })
    expect(res.status).toBe(303)
    const location = res.headers.get("location")
    expect(location).toBe("/some/path")
    const cookie = readSetCookie(res)
    expect(cookie).toContain(`${COOKIE_NAME}=${handle.token}`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("Path=/")
  })

  it("the cookie alone then authenticates and proxies through to the real target", async () => {
    const { base, handle } = await setup()
    const res = await fetch(`${base}/hello?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(res)!.split(";")[0]!

    const proxied = await fetch(`${base}/hello`, { headers: { cookie } })
    expect(proxied.status).toBe(200)
    expect(await proxied.text()).toContain("hello /hello")
    expect(proxied.headers.get("x-robots-tag")).toBe("noindex")
  })

  describe("public base forwarding", () => {
    async function authed(): Promise<{ port: number; cookie: string }> {
      const { base, handle } = await setup()
      const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
      return { port: handle.port, cookie: readSetCookie(first)!.split(";")[0]! }
    }

    it("forwards x-forwarded-proto https and a daemon-signed public base for a public Host", async () => {
      const { port, cookie } = await authed()
      const seen = await echoHeaders(port, { cookie, host: "demo.example.test" })
      expect(seen["x-forwarded-host"]).toBe("demo.example.test")
      expect(seen["x-forwarded-proto"]).toBe("https")
      expect(
        resolvePublicBase({ host: "127.0.0.1:1", [PUBLIC_BASE_HEADER]: seen[PUBLIC_BASE_HEADER] }),
      ).toMatchObject({ baseUrl: "https://demo.example.test", source: "trusted-header" })
    })

    it("keeps a client-supplied x-forwarded-proto and strips a client-supplied public base header", async () => {
      const { port, cookie } = await authed()
      const spoofed = signPublicBase("https://evil.example.test/d/x")
      const seen = await echoHeaders(port, {
        cookie,
        host: "demo.example.test",
        "x-forwarded-proto": "http",
        [PUBLIC_BASE_HEADER]: spoofed,
      })
      expect(seen["x-forwarded-proto"]).toBe("http")
      expect(seen[PUBLIC_BASE_HEADER]).not.toBe(spoofed)
      expect(
        resolvePublicBase({ host: "127.0.0.1:1", [PUBLIC_BASE_HEADER]: seen[PUBLIC_BASE_HEADER] }).baseUrl,
      ).toBe("http://demo.example.test")
    })

    it("never signs a base for a loopback Host", async () => {
      const { port, cookie } = await authed()
      const seen = await echoHeaders(port, { cookie, host: `127.0.0.1:${port}` })
      expect(seen[PUBLIC_BASE_HEADER]).toBeUndefined()
      expect(seen["x-forwarded-proto"]).toBeUndefined()
    })
  })

  it("blocks /@fs/ and source maps even with a valid cookie", async () => {
    const { base, handle } = await setup()
    const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(first)!.split(";")[0]!

    const fs = await fetch(`${base}/@fs/etc/passwd`, { headers: { cookie } })
    expect(fs.status).toBe(403)

    const map = await fetch(`${base}/app.js.map`, { headers: { cookie } })
    expect(map.status).toBe(403)
  })

  it("blocks percent-encoded and doubly-encoded variants of the same sensitive paths", async () => {
    const { base, handle } = await setup()
    const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(first)!.split(";")[0]!

    const encoded = await fetch(`${base}/%40fs/etc/passwd`, { headers: { cookie } })
    expect(encoded.status).toBe(403)

    const doubly = await fetch(`${base}/%2540fs/etc/passwd`, { headers: { cookie } })
    expect(doubly.status).toBe(403)

    const doubleSlash = await fetch(`${base}//@fs/etc/passwd`, { headers: { cookie } })
    expect(doubleSlash.status).toBe(403)

    const encodedMap = await fetch(`${base}/app.js%2Emap`, { headers: { cookie } })
    expect(encodedMap.status).toBe(403)
  })

  it("revoke invalidates the previous token and cookie immediately", async () => {
    const { base, guard, handle } = await setup()
    const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(first)!.split(";")[0]!
    expect((await fetch(`${base}/hello`, { headers: { cookie } })).status).toBe(200)

    const fresh = guard.revoke()
    expect(fresh.token).not.toBe(handle.token)

    expect((await fetch(`${base}/hello`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${base}/?t=${handle.token}`)).status).toBe(403)

    // The new token works.
    const again = await fetch(`${base}/hello?t=${fresh.token}`, { redirect: "manual" })
    expect(again.status).toBe(303)
  })

  it("a token stops verifying after the TTL elapses", async () => {
    const { base, handle } = await setup(50)
    await new Promise(resolve => setTimeout(resolve, 80))
    const res = await fetch(`${base}/?t=${handle.token}`)
    expect(res.status).toBe(403)
  })

  it("stop() tears the listener down", async () => {
    const { base, guard } = await setup()
    await guard.stop()
    guardStop = undefined
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })

  it("forwards the client's Host as X-Forwarded-Host and rewrites Host to the target", async () => {
    const { base, handle } = await setup()
    const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(first)!.split(";")[0]!

    const res = await fetch(`${base}/echo-headers`, { headers: { cookie } })
    const seen = (await res.json()) as Record<string, string>
    expect(seen["x-forwarded-host"]).toBe(`127.0.0.1:${handle.port}`)
    expect(seen.host).toBe(`127.0.0.1:${target!.port}`)
  })

  it("preserves a pre-existing X-Forwarded-Host from an upstream proxy", async () => {
    const { base, handle } = await setup()
    const first = await fetch(`${base}/?t=${handle.token}`, { redirect: "manual" })
    const cookie = readSetCookie(first)!.split(";")[0]!

    const res = await fetch(`${base}/echo-headers`, {
      headers: { cookie, "x-forwarded-host": "public.example.test" },
    })
    const seen = (await res.json()) as Record<string, string>
    expect(seen["x-forwarded-host"]).toBe("public.example.test")
    expect(seen.host).toBe(`127.0.0.1:${target!.port}`)
  })
})
