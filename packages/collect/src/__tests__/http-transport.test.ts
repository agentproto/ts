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
import { fakeBrowser, fakeClock, recipeOf } from "./engine-helpers"

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
    expect(parseRetryAfter("Wed, 21 Oct 2099 07:28:00 GMT", 0)).toBeGreaterThan(0)
    expect(parseRetryAfter("junk", 0)).toBeUndefined()
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

  it("a caller abort is a network error and is not retried", async () => {
    routes.set("/hang", () => undefined)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    const e = await caught(createHttpTransport(fast).request({ url: `${base}/hang`, signal: ac.signal }))
    expect(e.cause).toBe("network")
    expect(seen).toHaveLength(1)
  })

  it("an empty 2xx body is empty", async () => {
    routes.set("/e", (_q, res) => res.writeHead(200).end())
    routes.set("/n", (_q, res) => res.writeHead(204).end())
    expect(await caught(createHttpTransport(fast).request({ url: `${base}/e` }))).toMatchObject({ cause: "empty", status: 200 })
    expect((await caught(createHttpTransport(fast).request({ url: `${base}/n` }))).cause).toBe("empty")
  })

  it("recognises a challenge page, on 403 and on a small 200, and does not retry it", async () => {
    routes.set("/c", (_q, res) => text(res, 403, "<html><head><title>Just a moment...</title></head><body>cf-chl-x</body></html>"))
    routes.set("/c503", (_q, res) => text(res, 503, "<p>Please verify you are human</p>"))
    routes.set("/c200", (_q, res) => text(res, 200, '<div class="g-recaptcha"></div>'))
    routes.set("/hdr", (_q, res) => text(res, 403, "x", { "cf-mitigated": "challenge" }))
    const t = createHttpTransport(fast)
    for (const p of ["/c", "/c503", "/c200", "/hdr"]) expect((await caught(t.request({ url: `${base}${p}` }))).cause).toBe("challenge")
    expect(seen).toHaveLength(4)
    const e = await caught(t.request({ url: `${base}/c` }))
    expect(e.status).toBe(403)
    expect(dec(e.body!)).toContain("Just a moment")
  })

  it("a long 200 page that merely mentions a captcha is content", async () => {
    routes.set("/long", (_q, res) => text(res, 200, `<p>about g-recaptcha</p>${"a".repeat(60_000)}`))
    expect((await createHttpTransport(fast).request({ url: `${base}/long` })).status).toBe(200)
    routes.set("/json", (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"x":"g-recaptcha"}'))
    expect((await createHttpTransport(fast).request({ url: `${base}/json` })).status).toBe(200)
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

  it("does not forward a header secret to another origin on redirect", async () => {
    const other = createServer((req, res) => {
      seen.push({ path: "other", headers: req.headers, at: 0 })
      res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    })
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r))
    const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    routes.set("/go", (_q, res) => res.writeHead(302, { location: `${otherBase}/x` }).end())
    try {
      await createApiTransport({ http, secrets, auth: { type: "header", name: "X-Api-Key", secret: "KEY" } }).request({ url: `${base}/go` })
    } finally {
      await new Promise((r) => other.close(r))
    }
    expect(seen[0]!.headers["x-api-key"]).toBeDefined()
    expect(seen[1]!.path).toBe("other")
    expect(seen[1]!.headers["x-api-key"]).toBeUndefined()
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

  it("a missing secret under the api transport skips the task", async () => {
    const needsKey = defineConnector({
      ...connector,
      id: "keyed",
      transports: ["api"],
      async fetch(_t, transport) {
        if (transport.name === "browser") throw new Error("unused")
        const res = await transport.http.request({ url: `${base}/page` })
        return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
      },
    })
    const collector = createCollector({
      store: memoryStore(),
      transports: {
        api: createApiTransport({ http: createHttpTransport(fast), secrets: { get: async () => undefined }, auth: { type: "bearer", secret: "K" } }),
      },
      connectors: [needsKey],
    })
    const report = await collector.run(recipeOf(["keyed"]))
    expect(report.connectors[0]).toMatchObject({ status: "partial", tasks: { planned: 1, done: 0, skipped: 1, failed: 0 } })
    expect(seen).toHaveLength(0)
  })
})
