import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  MissingSecretError,
  TransportError,
  createCollector,
  defineConnector,
  memoryStore,
  readAll,
  type HttpRequest,
} from "../index"
import { createApiTransport, createHttpTransport, parseRetryAfter } from "../node"
import { fakeBrowser, fakeClock, fakeHttp, recipeOf } from "./engine-helpers"

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let server: Server
let base = ""
const routes = new Map<string, Handler>()
const seen: Array<{ path: string; headers: IncomingMessage["headers"]; at: number }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers, at: Date.now() })
    const path = (req.url ?? "").split("?")[0]!
    const h = routes.get(path)
    if (!h) {
      res.writeHead(404).end("nope")
      return
    }
    h(req, res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  routes.clear()
  seen.length = 0
})

const fast = { minIntervalMs: 0 }
const text = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "text/html", ...headers }).end(body)
}
const caught = async (p: Promise<unknown>): Promise<TransportError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError)
    return e as TransportError
  }
  throw new Error("expected a rejection")
}
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe("http transport", () => {
  it("returns a 2xx response with a generic user agent", async () => {
    routes.set("/ok", (_q, res) => text(res, 200, "hello"))
    const res = await createHttpTransport(fast).request({ url: `${base}/ok` })
    expect(res.status).toBe(200)
    expect(dec(res.body)).toBe("hello")
    expect(res.url).toBe(`${base}/ok`)
    expect(seen[0]!.headers["user-agent"]).toBe("agentproto-collect")
    await createHttpTransport({ ...fast, userAgent: "x/1" }).request({ url: `${base}/ok` })
    expect(seen[1]!.headers["user-agent"]).toBe("x/1")
  })

  it("retries a 429 and honours Retry-After in seconds", async () => {
    let n = 0
    routes.set("/r", (_q, res) => (n++ === 0 ? text(res, 429, "slow down", { "retry-after": "2" }) : text(res, 200, "ok")))
    const clock = fakeClock()
    const res = await createHttpTransport({ ...fast, clock }).request({ url: `${base}/r` })
    expect(res.status).toBe(200)
    expect(clock.sleeps).toEqual([2000])
  })

  it("honours Retry-After as an HTTP date", async () => {
    const clock = fakeClock()
    let n = 0
    routes.set("/d", (_q, res) =>
      n++ === 0 ? text(res, 503, "later", { "retry-after": new Date(clock.now() + 7000).toUTCString() }) : text(res, 200, "ok"),
    )
    await createHttpTransport({ ...fast, clock }).request({ url: `${base}/d` })
    expect(clock.sleeps).toHaveLength(1)
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(6000)
    expect(clock.sleeps[0]).toBeLessThanOrEqual(7000)
  })

  it("parses Retry-After strictly", () => {
    const now = Date.parse("1994-11-06T08:49:00Z")
    expect(parseRetryAfter("120", now)).toBe(120_000)
    expect(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", now)).toBe(37_000)
    expect(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", now)).toBe(37_000)
    expect(parseRetryAfter("Sun Nov  6 08:49:37 1994", now)).toBe(37_000)
    expect(parseRetryAfter("Sun, 06 Nov 1994 08:40:00 GMT", now)).toBe(0)
    for (const bad of ["", "junk", "-5", "1.5", "1e3", "+3", "0x10", "12 seconds", "Nov 6 1994", "2026-11-28T10:00:00Z", "Sun, 06 Nov 1994 08:49:37 PST", "99999999999"]) {
      expect(parseRetryAfter(bad, now), bad).toBeUndefined()
    }
  })

  it("ignores a malformed Retry-After and backs off instead", async () => {
    let n = 0
    routes.set("/bad", (_q, res) => (n++ === 0 ? text(res, 429, "x", { "retry-after": "soon" }) : text(res, 200, "ok")))
    const clock = fakeClock()
    await createHttpTransport({ ...fast, clock, random: () => 0, baseDelayMs: 100 }).request({ url: `${base}/bad` })
    expect(clock.sleeps).toEqual([50])
  })

  it("validates the options", () => {
    for (const o of [
      { timeoutMs: Number.POSITIVE_INFINITY },
      { timeoutMs: Number.NaN },
      { timeoutMs: 0 },
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
      { maxAttempts: Number.POSITIVE_INFINITY },
      { baseDelayMs: -1 },
      { maxBackoffMs: Number.NaN },
      { maxRetryAfterMs: -1 },
      { maxRetryAfterMs: 1e12 },
      { minIntervalMs: Number.POSITIVE_INFINITY },
      { maxBytes: 0 },
      { maxBytes: 1e15 },
      { maxRedirects: -1 },
    ]) {
      expect(() => createHttpTransport(o), JSON.stringify(o)).toThrow(RangeError)
    }
    expect(() => createHttpTransport({ minIntervalMs: 0, maxRedirects: 0 })).not.toThrow()
  })

  it("gives up with http/429 when Retry-After exceeds the cap, without waiting", async () => {
    routes.set("/long", (_q, res) => text(res, 429, "no", { "retry-after": "3600" }))
    const clock = fakeClock()
    const e = await caught(createHttpTransport({ ...fast, clock, maxRetryAfterMs: 5000 }).request({ url: `${base}/long` }))
    expect(e).toMatchObject({ cause: "http", status: 429 })
    expect(clock.sleeps).toEqual([])
    expect(seen).toHaveLength(1)
  })

  it("a 429 still failing after the attempts is http/429", async () => {
    routes.set("/always", (_q, res) => text(res, 429, "no", { "retry-after": "1" }))
    const e = await caught(createHttpTransport({ ...fast, clock: fakeClock() }).request({ url: `${base}/always` }))
    expect(e).toMatchObject({ cause: "http", status: 429, ext: "html" })
    expect(dec(e.body!)).toBe("no")
    expect(seen).toHaveLength(3)
  })

  it("401 and 403 are blocked and not retried", async () => {
    routes.set("/f", (_q, res) => text(res, 403, "forbidden"))
    const e = await caught(createHttpTransport(fast).request({ url: `${base}/f` }))
    expect(e).toMatchObject({ cause: "blocked", status: 403, url: `${base}/f` })
    expect(seen).toHaveLength(1)
    routes.set("/u", (_q, res) => text(res, 401, "who"))
    expect(await caught(createHttpTransport(fast).request({ url: `${base}/u` }))).toMatchObject({ cause: "blocked", status: 401 })
  })

  it("retries a 503 then succeeds, with exponential jittered backoff", async () => {
    let n = 0
    routes.set("/s", (_q, res) => (n++ < 2 ? text(res, 503, "down") : text(res, 200, "up")))
    const clock = fakeClock()
    const res = await createHttpTransport({ ...fast, clock, random: () => 0.5, baseDelayMs: 100 }).request({ url: `${base}/s` })
    expect(dec(res.body)).toBe("up")
    expect(clock.sleeps).toEqual([75, 150])
  })

  it("does not retry a POST on 503, nor a plain 404", async () => {
    routes.set("/p", (_q, res) => text(res, 503, "down"))
    const e = await caught(createHttpTransport(fast).request({ url: `${base}/p`, method: "POST", body: "x" }))
    expect(e).toMatchObject({ cause: "http", status: 503 })
    expect(seen).toHaveLength(1)
    seen.length = 0
    expect(await caught(createHttpTransport(fast).request({ url: `${base}/missing` }))).toMatchObject({ cause: "http", status: 404 })
    expect(seen).toHaveLength(1)
  })

  it("a timeout is a network error, retried", async () => {
    routes.set("/hang", () => undefined)
    const e = await caught(
      createHttpTransport({ ...fast, timeoutMs: 80, maxAttempts: 2, baseDelayMs: 1, maxBackoffMs: 1 }).request({ url: `${base}/hang` }),
    )
    expect(e.cause).toBe("network")
    expect(e.message).toMatch(/timed out/)
    expect(seen).toHaveLength(2)
  })

  it("a refused connection is a network error", async () => {
    const e = await caught(createHttpTransport({ ...fast, maxAttempts: 1 }).request({ url: "http://127.0.0.1:1/x" }))
    expect(e.cause).toBe("network")
  })

  it("a caller abort, once the server has the request, is a network error and is not retried", async () => {
    const received = new Promise<void>((resolve) => routes.set("/hang", () => resolve()))
    const ac = new AbortController()
    const pending = caught(createHttpTransport(fast).request({ url: `${base}/hang`, signal: ac.signal }))
    await received
    ac.abort()
    const e = await pending
    expect(e.cause).toBe("network")
    expect(e.message).toMatch(/aborted/)
    expect(seen).toHaveLength(1)
  })

  it("a stalled 2xx body is a network error after the timeout", async () => {
    const stalled = (_q: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "100" })
      res.write("partial")
    }
    routes.set("/stall", stalled)
    const e = await caught(createHttpTransport({ ...fast, timeoutMs: 100, maxAttempts: 1 }).request({ url: `${base}/stall` }))
    expect(e.cause).toBe("network")
    expect(e.message).toMatch(/timed out/)
  })

  it("a stalled 429 body still classifies by status and Retry-After", async () => {
    routes.set("/stall429", (_q, res) => {
      res.writeHead(429, { "content-type": "text/html", "content-length": "500", "retry-after": "3600" })
      res.write("<p>slow</p>")
    })
    const clock = fakeClock()
    const e = await caught(createHttpTransport({ ...fast, clock, timeoutMs: 150, maxRetryAfterMs: 5000 }).request({ url: `${base}/stall429` }))
    expect(e).toMatchObject({ cause: "http", status: 429 })
    expect(e.message).toMatch(/Retry-After/)
    expect(clock.sleeps).toEqual([])
    expect(seen).toHaveLength(1)
    routes.set("/stall403", (_q, res) => {
      res.writeHead(403, { "content-length": "500" })
      res.write("no")
    })
    expect(await caught(createHttpTransport({ ...fast, timeoutMs: 150 }).request({ url: `${base}/stall403` }))).toMatchObject({ cause: "blocked", status: 403 })
  })

  it("a reset error body still classifies by status", async () => {
    routes.set("/reset403", (_q, res) => {
      res.writeHead(403, { "content-length": "500" })
      res.write("no")
      setTimeout(() => res.socket?.destroy(), 20)
    })
    expect(await caught(createHttpTransport(fast).request({ url: `${base}/reset403` }))).toMatchObject({ cause: "blocked", status: 403 })
  })

  it("a socket closed before or during a 2xx response is a network error", async () => {
    routes.set("/drop", (_q, res) => res.socket?.destroy())
    routes.set("/cut", (_q, res) => {
      res.writeHead(200, { "content-length": "100" })
      res.write("part")
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const t = createHttpTransport({ ...fast, maxAttempts: 1 })
    expect((await caught(t.request({ url: `${base}/drop` }))).cause).toBe("network")
    expect((await caught(t.request({ url: `${base}/cut` }))).cause).toBe("network")
  })

  it("a caller abort wins over a response whose status had arrived", async () => {
    const received = new Promise<void>((resolve) =>
      routes.set("/slow429", (_q, res) => {
        res.writeHead(429, { "content-length": "500" })
        res.write("x")
        resolve()
      }),
    )
    const ac = new AbortController()
    const pending = caught(createHttpTransport(fast).request({ url: `${base}/slow429`, signal: ac.signal }))
    await received
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    expect((await pending).cause).toBe("network")
  })

  it("an abort ends a wait in the limiter queue", async () => {
    routes.set("/ok", (_q, res) => text(res, 200, "ok"))
    const t = createHttpTransport({ minIntervalMs: 60_000 })
    await t.request({ url: `${base}/ok` })
    const ac = new AbortController()
    const waiting = caught(t.request({ url: `${base}/ok`, signal: ac.signal }))
    setTimeout(() => ac.abort(), 20)
    const e = await waiting
    expect(e.cause).toBe("network")
    expect(seen).toHaveLength(1)
  })

  it("an empty 2xx body is empty", async () => {
    routes.set("/e", (_q, res) => res.writeHead(200).end())
    routes.set("/n", (_q, res) => res.writeHead(204).end())
    expect(await caught(createHttpTransport(fast).request({ url: `${base}/e` }))).toMatchObject({ cause: "empty", status: 200 })
    expect((await caught(createHttpTransport(fast).request({ url: `${base}/n` }))).cause).toBe("empty")
  })

  it("recognises an interstitial on a challenge status, and does not retry it", async () => {
    routes.set("/c", (_q, res) => text(res, 403, "<html><head><title>Just a moment...</title></head><body>cf-chl-x</body></html>"))
    routes.set("/c503", (_q, res) => text(res, 503, "<p>Please verify you are human</p>"))
    routes.set("/cw", (_q, res) => text(res, 429, `<div class="g-recaptcha"></div>${"x".repeat(9000)}`))
    routes.set("/hdr", (_q, res) => text(res, 403, "x", { "cf-mitigated": "challenge" }))
    const t = createHttpTransport(fast)
    for (const p of ["/c", "/c503", "/cw", "/hdr"]) expect((await caught(t.request({ url: `${base}${p}` }))).cause).toBe("challenge")
    expect(seen).toHaveLength(4)
    const e = await caught(t.request({ url: `${base}/c` }))
    expect(e.status).toBe(403)
    expect(dec(e.body!)).toContain("Just a moment")
  })

  it("a page that is nothing but the widget is a challenge", async () => {
    routes.set("/w", (_q, res) => text(res, 200, '<html><body><div class="cf-turnstile"></div><script src="x.js"></script></body></html>'))
    expect((await caught(createHttpTransport(fast).request({ url: `${base}/w` }))).cause).toBe("challenge")
  })

  it("a normal page that embeds a widget or quotes a verification phrase is content", async () => {
    const article = `<html><body><h1>Contact us</h1><p>${"Real article text. ".repeat(40)}</p><div class="g-recaptcha"></div></body></html>`
    routes.set("/form", (_q, res) => text(res, 200, article))
    routes.set("/phrase", (_q, res) => text(res, 200, `<p>Some sites ask you to verify you are human. ${"More text. ".repeat(30)}</p>`))
    routes.set("/long", (_q, res) => text(res, 200, `<p>about g-recaptcha</p>${"a".repeat(60_000)}`))
    routes.set("/json", (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"x":"g-recaptcha"}'))
    routes.set("/forbidden", (_q, res) => text(res, 403, "<p>You do not have access to this page.</p>"))
    const t = createHttpTransport(fast)
    for (const p of ["/form", "/phrase", "/long", "/json"]) expect((await t.request({ url: `${base}${p}` })).status, p).toBe(200)
    // A plain 403 without an interstitial marker is blocked, not a challenge.
    expect((await caught(t.request({ url: `${base}/forbidden` }))).cause).toBe("blocked")
  })

  it("follows a redirect chain and returns the final url", async () => {
    routes.set("/a", (_q, res) => res.writeHead(301, { location: "/b" }).end())
    routes.set("/b", (_q, res) => res.writeHead(302, { location: `${base}/c?x=1` }).end())
    routes.set("/c", (_q, res) => text(res, 200, "end"))
    const res = await createHttpTransport(fast).request({ url: `${base}/a` })
    expect(res.url).toBe(`${base}/c?x=1`)
    expect(dec(res.body)).toBe("end")
    routes.set("/loop", (_q, res) => res.writeHead(302, { location: "/loop" }).end())
    const e = await caught(createHttpTransport({ ...fast, maxRedirects: 3 }).request({ url: `${base}/loop` }))
    expect(e).toMatchObject({ cause: "http", status: 302 })
  })

  it("a redirect that turns a POST into a GET drops the body and its headers", async () => {
    routes.set("/post", (_q, res) => res.writeHead(302, { location: "/after" }).end())
    routes.set("/after", (_q, res) => text(res, 200, "ok"))
    await createHttpTransport(fast).request({
      url: `${base}/post`,
      method: "POST",
      body: "a=1",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Encoding": "identity", "X-Keep": "1" },
    })
    expect(seen[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(seen[1]!.headers["content-type"]).toBeUndefined()
    expect(seen[1]!.headers["content-length"]).toBeUndefined()
    expect(seen[1]!.headers["content-encoding"]).toBeUndefined()
    expect(seen[1]!.headers["x-keep"]).toBe("1")
  })

  it("enforces the size cap on declared and streamed bodies", async () => {
    routes.set("/big", (_q, res) => text(res, 200, "x".repeat(5000)))
    routes.set("/stream", (_q, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("y".repeat(3000))
      setTimeout(() => res.end("y".repeat(3000)), 20)
    })
    const t = createHttpTransport({ ...fast, maxBytes: 4000 })
    expect(await caught(t.request({ url: `${base}/big` }))).toMatchObject({ cause: "http", status: 200 })
    const e = await caught(t.request({ url: `${base}/stream` }))
    expect(e).toMatchObject({ cause: "http", status: 200 })
    expect(e.message).toMatch(/cap/)
    expect(seen).toHaveLength(2)
    routes.set("/declared", (_q, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "999999999" })
      res.write("tiny")
    })
    const d = await caught(t.request({ url: `${base}/declared` }))
    expect(d).toMatchObject({ cause: "http", status: 200 })
    expect(d.message).toMatch(/999999999 bytes exceeds/)
    routes.set("/err", (_q, res) => text(res, 500, "z".repeat(9000)))
    const f = await caught(createHttpTransport({ ...fast, maxBytes: 4000, maxAttempts: 1 }).request({ url: `${base}/err` }))
    expect(f.status).toBe(500)
    expect(f.body!.byteLength).toBe(4000)
  })

  it("spaces requests to one host by the per-host interval (fake clock)", async () => {
    routes.set("/ok", (_q, res) => text(res, 200, "ok"))
    const clock = fakeClock()
    const t = createHttpTransport({ clock, minIntervalMs: 1000 })
    await Promise.all([t.request({ url: `${base}/ok` }), t.request({ url: `${base}/ok` }), t.request({ url: `${base}/ok` })])
    expect(clock.sleeps).toEqual([1000, 1000])
    expect(clock.t - Date.parse("2026-11-28T10:00:00Z")).toBe(2000)
    // Retries and redirect hops go through the same pacing point.
    routes.set("/h1", (_q, res) => res.writeHead(302, { location: "/h2" }).end())
    routes.set("/h2", (_q, res) => text(res, 200, "ok"))
    const hops = fakeClock()
    await createHttpTransport({ clock: hops, minIntervalMs: 500 }).request({ url: `${base}/h1` })
    expect(hops.sleeps).toEqual([500])
    let n = 0
    routes.set("/flaky", (_q, res) => (n++ === 0 ? text(res, 503, "x") : text(res, 200, "ok")))
    const retries = fakeClock()
    await createHttpTransport({ clock: retries, minIntervalMs: 500, random: () => 0, baseDelayMs: 100 }).request({ url: `${base}/flaky` })
    expect(retries.sleeps).toEqual([50, 450])
    const off = fakeClock()
    await createHttpTransport({ clock: off, minIntervalMs: 0 }).request({ url: `${base}/ok` })
    expect(off.sleeps).toEqual([])
  })
})

describe("api transport", () => {
  const secrets = { get: async (n: string) => (n === "KEY" ? "s3cr&t key" : undefined) }
  const echo: Handler = (req, res) => text(res, 200, "ok")
  const http = createHttpTransport(fast)

  it("injects a bearer token, a named header and a query parameter", async () => {
    routes.set("/api", echo)
    await createApiTransport({ http, secrets, auth: { type: "bearer", secret: "KEY" } }).request({ url: `${base}/api` })
    expect(seen[0]!.headers.authorization).toBe("Bearer s3cr&t key")
    await createApiTransport({ http, secrets, auth: { type: "header", name: "X-Api-Key", secret: "KEY", prefix: "k " } }).request({
      url: `${base}/api`,
      headers: { "x-api-key": "old" },
    })
    expect(seen[1]!.headers["x-api-key"]).toBe("k s3cr&t key")
    const res = await createApiTransport({ http, secrets, auth: { type: "query", name: "key", secret: "KEY" } }).request({
      url: `${base}/api?a=1`,
    })
    expect(new URL(`http://h${seen[2]!.path}`).searchParams.get("key")).toBe("s3cr&t key")
    expect(res.url).toBe(`${base}/api?a=1`)
  })

  it("a missing secret throws a typed error and sends nothing", async () => {
    const t = createApiTransport({ http, secrets, auth: { type: "bearer", secret: "NOPE" } })
    const e = await t.request({ url: `${base}/api` }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(MissingSecretError)
    expect((e as MissingSecretError).message).toBe('missing secret "NOPE"')
    expect(seen).toHaveLength(0)
  })

  it("never lets the secret out in an error, url or body", async () => {
    routes.set("/leak", (req, res) => text(res, 403, `bad key ${req.headers.authorization} / ${req.url}`))
    for (const auth of [
      { type: "query", name: "key", secret: "KEY" } as const,
      { type: "bearer", secret: "KEY" } as const,
    ]) {
      const e = await caught(createApiTransport({ http, secrets, auth }).request({ url: `${base}/leak` }))
      const all = JSON.stringify([e.message, e.url, dec(e.body!), e.status, e.cause, String(e.origin)])
      expect(all).not.toContain("s3cr")
      expect(all).not.toContain("s3cr%26t")
      expect(e.cause).toBe("blocked")
    }
    const dead = createApiTransport({
      http: createHttpTransport({ ...fast, maxAttempts: 1 }),
      secrets,
      auth: { type: "query", name: "key", secret: "KEY" },
    })
    const e = await caught(dead.request({ url: "http://127.0.0.1:1/x" }))
    expect(JSON.stringify([e.message, e.url])).not.toContain("s3cr")
  })

  it("redacts the secret from a successful body and headers", async () => {
    routes.set("/echo", (req, res) =>
      res.writeHead(200, { "content-type": "text/plain", "x-echo": String(req.headers.authorization) }).end(`you sent ${req.headers.authorization} and ${req.url}`),
    )
    for (const auth of [{ type: "bearer", secret: "KEY" } as const, { type: "query", name: "key", secret: "KEY" } as const]) {
      const res = await createApiTransport({ http, secrets, auth }).request({ url: `${base}/echo` })
      const all = dec(res.body) + JSON.stringify(res.headers) + res.url
      expect(all).not.toContain("s3cr")
      expect(all).toContain("[redacted]")
    }
  })

  describe("redirects to another origin", () => {
    let other: Server
    let otherBase = ""
    const seenOther: Array<IncomingMessage["headers"]> = []
    beforeAll(async () => {
      other = createServer((req, res) => {
        seenOther.push(req.headers)
        text(res, 200, "ok")
      })
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r))
      otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      other.closeAllConnections()
      await new Promise((r) => other.close(r))
    })
    beforeEach(() => {
      seenOther.length = 0
      routes.set("/go", (_q, res) => res.writeHead(302, { location: `${otherBase}/x` }).end())
      routes.set("/same", (_q, res) => res.writeHead(302, { location: "/echo" }).end())
      routes.set("/echo", echo)
    })

    it("strips a bearer token, a custom header and a cookie on the cross-origin hop", async () => {
      const bearer = createApiTransport({ http, secrets, auth: { type: "bearer", secret: "KEY" } })
      await bearer.request({ url: `${base}/go`, headers: { Cookie: "sid=1" } })
      expect(seen[0]!.headers.authorization).toBeDefined()
      expect(seen[0]!.headers.cookie).toBe("sid=1")
      expect(seenOther[0]!.authorization).toBeUndefined()
      expect(seenOther[0]!.cookie).toBeUndefined()

      const custom = createApiTransport({ http, secrets, auth: { type: "header", name: "X-Api-Key", secret: "KEY" } })
      await custom.request({ url: `${base}/go` })
      expect(seenOther[1]!["x-api-key"]).toBeUndefined()
      expect(seenOther[1]!["user-agent"]).toBe("agentproto-collect")

      // Same-origin hops keep the credential.
      seen.length = 0
      await custom.request({ url: `${base}/same` })
      expect(seen[1]!.headers["x-api-key"]).toBeDefined()
    })

    it("refuses the cross-origin hop of a query-authenticated request with a blocked error", async () => {
      const query = createApiTransport({ http, secrets, auth: { type: "query", name: "key", secret: "KEY" } })
      const e = await caught(query.request({ url: `${base}/go` }))
      expect(e.cause).toBe("blocked")
      expect(e.status).toBeUndefined()
      expect(e.message).toMatch(/another origin/)
      expect(JSON.stringify([e.message, e.url])).not.toContain("s3cr")
      expect(seenOther).toHaveLength(0)
      // A same-origin redirect is fine.
      expect((await query.request({ url: `${base}/same` })).status).toBe(200)
    })

    it("a plain request with the urlCredential flag is refused too, a cookie is stripped without it", async () => {
      expect((await caught(http.request({ url: `${base}/go`, urlCredential: true }))).cause).toBe("blocked")
      await http.request({ url: `${base}/go`, headers: { Cookie: "a=b", Authorization: "Basic xx" } })
      expect(seenOther[0]!.cookie).toBeUndefined()
      expect(seenOther[0]!.authorization).toBeUndefined()
    })
  })
})

describe("engine over the real http transport", () => {
  const connector = defineConnector({
    id: "local",
    version: "1",
    transports: ["http", "browser"],
    access: { level: "none" },
    capabilities: ["list"],
    counters: [],
    pace: { delayMs: 0 },
    plan: () => [{ id: "p", params: {} }],
    async fetch(_task, transport) {
      if (transport.name === "browser") {
        const pg = await transport.browser.open(`${base}/page`)
        const data = await transport.browser.evaluate<{ posts: unknown[] }>(pg, "x")
        await transport.browser.close(pg)
        return { raws: [{ url: `${base}/page`, ext: "json", bytes: new TextEncoder().encode(JSON.stringify(data)), httpStatus: 200 }] }
      }
      const req: HttpRequest = { url: `${base}/page` }
      const res = await transport.http.request(req)
      return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
    },
    parse: (input) => {
      const data = JSON.parse(dec(input.raw.bytes)) as { posts: Array<{ id: string; text: string }> }
      return {
        items: data.posts.map((p) => ({ id: `local:${p.id}`, source: "local", kind: "post" as const, text: p.text, subjects: [] })),
        observations: [],
        actors: [],
      }
    },
  })

  it("a 403 over real HTTP falls back to the browser transport", async () => {
    routes.set("/page", (_q, res) => text(res, 403, "denied"))
    const browser = fakeBrowser()
    browser.respond.set(`${base}/page`, { posts: [{ id: "1", url: "https://site.test/1", text: "from the browser" }] })
    const store = memoryStore()
    const collector = createCollector({
      store,
      transports: { http: createHttpTransport({ minIntervalMs: 0 }), browser },
      connectors: [connector],
    })
    const report = await collector.run(recipeOf(["local"]))
    expect(seen.map((s) => s.path)).toEqual(["/page"])
    expect(browser.opened).toEqual([`${base}/page`])
    expect(report.connectors[0]).toMatchObject({ status: "ok", newItems: 1, escalations: [{ from: "http", to: "browser", count: 1 }] })
    expect((await readAll(store.items())).records.map((i) => i.text)).toEqual(["from the browser"])
  })

  it("stores a body that echoes the token redacted in the raw store", async () => {
    routes.set("/page", (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ posts: [{ id: "1", text: `token ${req.headers.authorization}` }] })))
    const echoing = defineConnector({
      ...connector,
      id: "echo",
      transports: ["api"],
      async fetch(_t, transport) {
        if (transport.name === "browser") throw new Error("unused")
        const res = await transport.http.request({ url: `${base}/page` })
        return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
      },
    })
    const store = memoryStore()
    await createCollector({
      store,
      transports: {
        api: createApiTransport({ http: createHttpTransport(fast), secrets: { get: async () => "tok-123-secret" }, auth: { type: "bearer", secret: "K" } }),
      },
      connectors: [echoing],
    }).run(recipeOf(["echo"]))
    const index = (await readAll(store.rawIndex())).records
    expect(index).toHaveLength(1)
    const stored = dec((await store.getRaw(index[0]!.ref))!)
    expect(stored).toContain("[redacted]")
    expect(stored).not.toContain("tok-123")
    expect((await readAll(store.items())).records.map((i) => i.text)).toEqual(["token Bearer [redacted]"])
  })

  describe("a missing secret", () => {
    const keyed = (transports: Array<"api" | "http">) =>
      defineConnector({
        ...connector,
        id: "keyed",
        transports,
        async fetch(_t, transport) {
          if (transport.name === "browser") throw new Error("unused")
          const res = await transport.http.request({ url: `${base}/page` })
          return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
        },
      })
    const noSecret = createApiTransport({ http: createHttpTransport(fast), secrets: { get: async () => undefined }, auth: { type: "bearer", secret: "SERVICE_KEY" } })

    it("falls through to the next declared transport", async () => {
      routes.set("/page", (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ posts: [{ id: "1", text: "public" }] })))
      const report = await createCollector({
        store: memoryStore(),
        transports: { api: noSecret, http: createHttpTransport(fast) },
        connectors: [keyed(["api", "http"])],
      }).run(recipeOf(["keyed"]))
      expect(report.connectors[0]).toMatchObject({ status: "ok", tasks: { done: 1, skipped: 0, failed: 0 }, escalations: [{ from: "api", to: "http", count: 1 }] })
      expect(seen).toHaveLength(1)
    })

    it("skips the connector with missing_secret:<NAME> when no transport remains", async () => {
      const store = memoryStore()
      const report = await createCollector({ store, transports: { api: noSecret }, connectors: [keyed(["api"])] }).run(recipeOf(["keyed"]))
      expect(report.connectors[0]).toMatchObject({ status: "skipped", skippedReason: "missing_secret:SERVICE_KEY", tasks: { skipped: 1, failed: 0, done: 0 } })
      expect((await readAll(store.tasks(report.runId))).records[0]).toMatchObject({ status: "skipped", reason: "missing_secret:SERVICE_KEY" })
      expect(seen).toHaveLength(0)
    })
  })

  it("combines the request signal with the collector signal", async () => {
    const own = new AbortController()
    const http = fakeHttp()
    let handed: AbortSignal | undefined
    http.respond.set("https://fake.example.com/a", (req) => {
      handed = req.signal
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ posts: [] })), url: req.url }
    })
    const probe = defineConnector({
      ...connector,
      id: "fake",
      async fetch(_t, transport) {
        if (transport.name === "browser") throw new Error("unused")
        const res = await transport.http.request({ url: "https://fake.example.com/a", signal: own.signal })
        return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
      },
    })
    const collectorSignal = new AbortController()
    await createCollector({ store: memoryStore(), transports: { http }, connectors: [probe] }).run(recipeOf(["fake"]), { signal: collectorSignal.signal })
    expect(handed).toBeDefined()
    expect(handed).not.toBe(own.signal)
    expect(handed!.aborted).toBe(false)
    collectorSignal.abort()
    expect(handed!.aborted).toBe(true)
    const second = new AbortController()
    const h2 = fakeHttp()
    let handed2: AbortSignal | undefined
    h2.respond.set("https://fake.example.com/a", (req) => {
      handed2 = req.signal
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ posts: [] })), url: req.url }
    })
    await createCollector({ store: memoryStore(), transports: { http: h2 }, connectors: [probe] }).run(recipeOf(["fake"]), { signal: second.signal })
    own.abort()
    expect(handed2!.aborted).toBe(true)
  })
})
