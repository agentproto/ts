import { afterEach, describe, expect, it } from "vitest"
import {
  type CollectStore,
  StoreLockedError,
  TransportError,
  createCollector,
  defineConnector,
  memoryStore,
  readAll,
  registerConnector,
  createConnectorRegistry,
  getConnector,
} from "../index"
import { initStore, openStore } from "../node"
import { enc, fakeBrowser, fakeClock, fakeConnector, fakeHttp, page, recipeOf } from "./engine-helpers"
import { testDir } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

const taskStates = async (store: CollectStore, runId: string) =>
  Object.fromEntries((await readAll(store.tasks(runId))).records.map((t) => [t.taskId, t.status]))
const all = async <T>(r: AsyncIterable<T> & { skipped: number }) => (await readAll(r as never)).records as T[]

function webOf(host: string, ids: string[], http = fakeHttp()) {
  for (const id of ids) {
    http.respond.set(`https://${host}/${id}`, page({ posts: [{ id, url: `https://site.test/${id}`, text: `text of ${id}`, views: 5 }] }))
  }
  return http
}

describe("connector declaration", () => {
  it("validates the declaration and registers once", () => {
    const c = fakeConnector({ id: "reg-a" })
    expect(c.pace.delayMs).toBe(0)
    expect(c.counters[0]).toMatchObject({ name: "views", primary: true })
    expect(() => defineConnector({ ...fakeConnectorDef(), id: "Bad Id" })).toThrow()
    expect(() => defineConnector({ ...fakeConnectorDef(), transports: [] })).toThrow()
    registerConnector(c)
    expect(getConnector("reg-a")).toBe(c)
    expect(() => registerConnector(c)).toThrow(/already registered/)
    const r = createConnectorRegistry([c])
    expect(r.list()).toEqual([c])
  })
})

function fakeConnectorDef() {
  const { plan, fetch, parse } = fakeConnector()
  return { id: "x", version: "1", transports: ["http" as const], plan, fetch, parse }
}

describe("engine", () => {
  it("runs a full pipeline and records everything", async () => {
    const store = memoryStore()
    const http = webOf("fake.example.com", ["a", "b", "c"])
    const events: string[] = []
    const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b", "c"] })] })
    const report = await collector.run(recipeOf(["fake"]), { onEvent: (e) => events.push(e.type) })

    expect(report.connectors).toHaveLength(1)
    expect(report.connectors[0]).toMatchObject({
      connector: "fake",
      status: "ok",
      tasks: { planned: 3, done: 3, failed: 0, skipped: 0 },
      newItems: 3,
      observations: 3,
      duplicates: 0,
      escalations: [],
    })
    expect(await all(store.items())).toHaveLength(3)
    expect(await taskStates(store, report.runId)).toEqual({ "fake/a": "done", "fake/b": "done", "fake/c": "done" })
    expect((await readAll(store.rawIndex())).records).toHaveLength(3)
    expect(await store.readReport(report.runId)).toEqual(report)
    const logged = (await readAll(store.events(report.runId))).records.map((e) => e.type)
    expect(logged[0]).toBe("run.start")
    expect(logged.filter((t) => t === "task.start")).toHaveLength(3)
    expect(logged.filter((t) => t === "task.end")).toHaveLength(3)
    expect(logged.at(-1)).toBe("run.end")
    expect(events).toEqual(logged)
    expect(report.coverage!.cells[0]).toMatchObject({ platform: "fake", items: 3, withPrimaryMetric: 3, withAuthorId: 3 })
    const item = (await all(store.items()))[0]!
    expect(item.rawRefs).toHaveLength(1)
    expect(item.runId).toBe(report.runId)
    expect(item.contentId).toMatch(/^[0-9a-f]{64}$/)
  })

  it("stops on abort, then resume refetches no done task", async () => {
    const store = memoryStore()
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"]
    const ac = new AbortController()
    const http = fakeHttp(0, (n) => {
      if (n === 2) ac.abort()
    })
    webOf("fake.example.com", ids, http)
    const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ids })] })
    const partial = await collector.run(recipeOf(["fake"], 1), { signal: ac.signal })

    expect(partial.connectors[0]).toMatchObject({ status: "partial", tasks: { planned: 6, done: 2 } })
    expect(http.calls).toHaveLength(2)
    expect(Object.values(await taskStates(store, partial.runId)).filter((s) => s === "pending")).toHaveLength(4)
    expect((await readAll(store.events(partial.runId))).records.some((e) => e.type === "cancelled")).toBe(true)

    const final = await collector.resume(partial.runId)
    expect(http.calls.map((c) => c.url)).toEqual(ids.map((i) => `https://fake.example.com/${i}`))
    expect(final.connectors[0]).toMatchObject({ status: "ok", tasks: { planned: 6, done: 6 }, newItems: 6 })
    expect(final.startedAt).toBe(partial.startedAt)
    expect(await all(store.items())).toHaveLength(6)
  })

  it("redoes a failed task on resume and leaves done ones", async () => {
    const store = memoryStore()
    const http = webOf("fake.example.com", ["a"])
    // b answers 500 first.
    http.respond.set("https://fake.example.com/b", page({ posts: [] }, 500))
    const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b"] })] })
    const first = await collector.run(recipeOf(["fake"]))
    expect(first.connectors[0]).toMatchObject({ status: "partial", failures: { network: 1 } })
    webOf("fake.example.com", ["b"], http)
    const second = await collector.resume(first.runId)
    expect(second.connectors[0]).toMatchObject({ status: "ok", tasks: { done: 2, failed: 0 } })
    expect(http.calls.filter((c) => c.url.endsWith("/a"))).toHaveLength(1)
  })

  it("skips a connector with no usable transport and carries on", async () => {
    const store = memoryStore()
    const http = webOf("fake.example.com", ["a"])
    const collector = createCollector({
      store,
      transports: { http },
      connectors: [
        fakeConnector({ tasks: ["a"] }),
        fakeConnector({ id: "needs-browser", transports: ["browser"], tasks: ["x", "y"] }),
        fakeConnector({ id: "needs-key", transports: ["api"], access: { level: "key", secret: "TOKEN" } }),
      ],
    })
    const report = await collector.run(recipeOf(["fake", "needs-browser", "needs-key", "unknown"]))
    const by = Object.fromEntries(report.connectors.map((c) => [c.connector, c]))
    expect(by.fake).toMatchObject({ status: "ok", newItems: 1 })
    expect(by["needs-browser"]).toMatchObject({ status: "skipped", tasks: { planned: 2, skipped: 2, done: 0 } })
    expect(by["needs-browser"]!.skippedReason).toMatch(/no usable transport/)
    expect(by["needs-key"]!.skippedReason).toMatch(/missing secret "TOKEN"/)
    expect(by.unknown).toMatchObject({ status: "skipped" })
    expect(by.unknown!.skippedReason).toMatch(/not registered/)
    expect(http.calls).toHaveLength(1)
  })

  it("skips on a missing secret even when a transport exists, and runs with the secret", async () => {
    const connector = fakeConnector({ transports: ["api"], access: { level: "key", secret: "TOKEN" } })
    const api = webOf("fake.example.com", ["a"])
    const without = await createCollector({ store: memoryStore(), transports: { api }, connectors: [connector] }).run(recipeOf(["fake"]))
    expect(without.connectors[0]!.status).toBe("skipped")
    expect(api.calls).toHaveLength(0)
    const withKey = await createCollector({
      store: memoryStore(),
      transports: { api },
      secrets: { get: async (n) => (n === "TOKEN" ? "s" : undefined) },
      connectors: [connector],
    }).run(recipeOf(["fake"]))
    expect(withKey.connectors[0]!.status).toBe("ok")
  })

  it("shares one per-host limiter between connectors", async () => {
    const clock = fakeClock()
    const http = fakeHttp()
    const seen: Array<{ at: number; url: string }> = []
    const inner = http.request.bind(http)
    http.request = async (r) => {
      seen.push({ at: clock.now(), url: r.url })
      return inner(r)
    }
    webOf("shared.test", ["a1", "a2", "b1", "b2"], http)
    const a = fakeConnector({ id: "ca", host: "shared.test", tasks: ["a1", "a2"], paceMs: 1000 })
    const b = fakeConnector({ id: "cb", host: "shared.test", tasks: ["b1", "b2"], paceMs: 1000 })
    const collector = createCollector({ store: memoryStore(), transports: { http }, connectors: [a, b], clock })
    const report = await collector.run(recipeOf(["ca", "cb"], 4))
    expect(report.connectors.every((c) => c.status === "ok")).toBe(true)
    expect(seen).toHaveLength(4)
    const times = seen.map((s) => s.at).sort((x, y) => x - y)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000)
    // Another host is not slowed down.
    expect(new Set(seen.map((s) => s.at)).size).toBe(4)
  })

  it("does not delay different hosts against each other", async () => {
    const clock = fakeClock()
    const http = fakeHttp()
    webOf("one.test", ["a"], http)
    webOf("two.test", ["b"], http)
    const collector = createCollector({
      store: memoryStore(),
      transports: { http },
      clock,
      connectors: [
        fakeConnector({ id: "ca", host: "one.test", tasks: ["a"], paceMs: 5000 }),
        fakeConnector({ id: "cb", host: "two.test", tasks: ["b"], paceMs: 5000 }),
      ],
    })
    await collector.run(recipeOf(["ca", "cb"]))
    expect(clock.sleeps).toEqual([])
  })

  it("falls back from http to browser on 403 and records the escalation", async () => {
    const store = memoryStore()
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/a", page({ posts: [] }, 403))
    const browser = fakeBrowser()
    browser.respond.set("https://fake.example.com/a", { posts: [{ id: "a", url: "https://site.test/a", text: "via browser", views: 9 }] })
    const collector = createCollector({
      store,
      transports: { http, browser },
      connectors: [fakeConnector({ transports: ["http", "browser"], tasks: ["a"] })],
    })
    const report = await collector.run(recipeOf(["fake"]))
    expect(report.connectors[0]).toMatchObject({
      status: "ok",
      newItems: 1,
      escalations: [{ from: "http", to: "browser", count: 1 }],
      failures: {},
    })
    expect(http.calls).toHaveLength(1)
    expect(browser.opened).toEqual(["https://fake.example.com/a"])
    const tasks = (await readAll(store.tasks(report.runId))).records
    expect(tasks[0]).toMatchObject({ status: "done", transport: "browser" })
    const index = (await readAll(store.rawIndex())).records
    expect(index.map((r) => [r.transport, r.httpStatus ?? 0, r.failure ?? ""])).toEqual([
      ["http", 403, "blocked"],
      ["browser", 200, ""],
    ])
    expect((await all(store.observations()))[0]!.transport).toBe("browser")
  })

  it("falls back on a challenge page, an empty body and a thrown blocked error", async () => {
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/c", () => ({ status: 200, headers: {}, body: enc("<html>verify</html>"), url: "x" }))
    http.respond.set("https://fake.example.com/e", () => ({ status: 200, headers: {}, body: new Uint8Array(), url: "x" }))
    http.respond.set("https://fake.example.com/t", () => {
      throw new TransportError("blocked", "blocked", { status: 429, url: "https://fake.example.com/t", body: enc("slow down"), ext: "html" })
    })
    const browser = fakeBrowser()
    for (const id of ["c", "e", "t"]) {
      browser.respond.set(`https://fake.example.com/${id}`, { posts: [{ id, url: `https://site.test/${id}`, text: id, views: 1 }] })
    }
    const base = fakeConnector({ transports: ["http", "browser"], tasks: ["c", "e", "t"] })
    // The challenge page is flagged by the connector.
    const connector = defineConnector({
      ...base,
      fetch: async (task, transport, ctx) => {
        const r = await base.fetch(task, transport, ctx)
        if (task.id === "c" && transport.name !== "browser") r.raws[0]!.challenge = true
        return r
      },
    })
    const store = memoryStore()
    const report = await createCollector({ store, transports: { http, browser }, connectors: [connector] }).run(recipeOf(["fake"]))
    expect(report.connectors[0]).toMatchObject({ status: "ok", newItems: 3, escalations: [{ from: "http", to: "browser", count: 3 }] })
    const causes = (await readAll(store.rawIndex())).records.filter((r) => r.failure).map((r) => r.failure).sort()
    expect(causes).toEqual(["blocked", "blocked", "empty"])
  })

  it("fails a task that fails on every transport, with its cause", async () => {
    const store = memoryStore()
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/a", page({ posts: [] }, 403))
    const browser = fakeBrowser()
    browser.open = async () => {
      throw new TransportError("challenge", "captcha")
    }
    const report = await createCollector({
      store,
      transports: { http, browser },
      connectors: [fakeConnector({ transports: ["http", "browser"], tasks: ["a"] })],
    }).run(recipeOf(["fake"]))
    expect(report.connectors[0]).toMatchObject({
      status: "failed",
      tasks: { planned: 1, done: 0, failed: 1 },
      failures: { blocked: 1 },
      escalations: [{ from: "http", to: "browser", count: 1 }],
    })
    expect((await readAll(store.tasks(report.runId))).records[0]).toMatchObject({ status: "failed", cause: "blocked" })
  })

  it("does not fall back on a network error", async () => {
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/a", () => {
      throw new TransportError("network", "reset")
    })
    const browser = fakeBrowser()
    const report = await createCollector({
      store: memoryStore(),
      transports: { http, browser },
      connectors: [fakeConnector({ transports: ["http", "browser"], tasks: ["a"] })],
    }).run(recipeOf(["fake"]))
    expect(browser.opened).toEqual([])
    expect(report.connectors[0]).toMatchObject({ status: "failed", failures: { network: 1 }, escalations: [] })
  })

  it("queues follow-up tasks in a deterministic order, and resumes them", async () => {
    const store = memoryStore()
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/a", page({ posts: [{ id: "a", url: "https://s.test/a", text: "a", views: 1 }], next: ["a2", "a1"] }))
    http.respond.set("https://fake.example.com/b", page({ posts: [{ id: "b", url: "https://s.test/b", text: "b", views: 1 }], next: ["b1"] }))
    http.respond.set("https://fake.example.com/a1", page({ posts: [{ id: "a1", url: "https://s.test/a1", text: "a1", views: 1 }], next: ["a" /* already known */] }))
    for (const id of ["a2", "b1"]) {
      http.respond.set(`https://fake.example.com/${id}`, page({ posts: [{ id, url: `https://s.test/${id}`, text: id, views: 1 }] }))
    }
    const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b"] })] })
    const report = await collector.run(recipeOf(["fake"], 1))
    expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["a", "a2", "a1", "b", "b1"])
    expect(report.connectors[0]).toMatchObject({ status: "ok", tasks: { planned: 5, done: 5 }, newItems: 5 })

    // An interrupted run keeps the follow-ups it queued, and resume fetches them.
    const store2 = memoryStore()
    const ac = new AbortController()
    const http2 = fakeHttp(0, (n) => n === 1 && ac.abort())
    http2.respond = http.respond
    const c2 = createCollector({ store: store2, transports: { http: http2 }, connectors: [fakeConnector({ tasks: ["a", "b"] })] })
    const partial = await c2.run(recipeOf(["fake"], 1), { signal: ac.signal })
    expect(partial.connectors[0]!.tasks.planned).toBe(4) // a, b, a2, a1
    const final = await c2.resume(partial.runId)
    expect(final.connectors[0]).toMatchObject({ status: "ok", tasks: { planned: 5, done: 5 } })
    // Resume redoes tasks in the order they were recorded.
    expect(http2.calls.map((c) => c.url.split("/").pop())).toEqual(["a", "b", "b1", "a2", "a1"])
  })

  it("applies the per-connector cap", async () => {
    const http = webOf("fake.example.com", ["a", "b", "c"])
    const report = await createCollector({
      store: memoryStore(),
      transports: { http },
      connectors: [fakeConnector({ tasks: ["a", "b", "c"], maxTasksPerRun: 2 })],
    }).run(recipeOf(["fake"], 1))
    expect(report.connectors[0]).toMatchObject({ status: "partial", tasks: { planned: 3, done: 2, skipped: 1 } })
    expect(http.calls).toHaveLength(2)
  })

  describe("dedup", () => {
    const one = (id: string, url: string, text: string, views = 1) => ({ id, url, text, views })

    it("level 1: a known native id gives a new observation and no new item", async () => {
      const store = memoryStore()
      const http = fakeHttp()
      http.respond.set("https://fake.example.com/a", page({ posts: [one("1", "https://s.test/1", "hello world", 10)] }))
      const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector()] })
      const first = await collector.run(recipeOf(["fake"]))
      http.respond.set("https://fake.example.com/a", page({ posts: [one("1", "https://s.test/1", "hello world", 25)] }))
      const second = await collector.run(recipeOf(["fake"]))
      expect(first.connectors[0]).toMatchObject({ newItems: 1, observations: 1, duplicates: 0 })
      expect(second.connectors[0]).toMatchObject({ status: "ok", newItems: 0, observations: 1, duplicates: 1 })
      expect(await all(store.items())).toHaveLength(1)
      expect((await all(store.observations())).map((o) => o.metrics.views)).toEqual([10, 25])
    })

    it("level 2: two urls differing by tracking parameters make one item", async () => {
      const store = memoryStore()
      const http = fakeHttp()
      http.respond.set(
        "https://fake.example.com/a",
        page({ posts: [one("1", "https://s.test/post?id=7&utm_source=x", "alpha beta", 3), one("2", "https://s.test/post?utm_medium=y&id=7", "alpha beta", 4)] }),
      )
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ newItems: 1, duplicates: 1, observations: 2 })
      const items = await all(store.items())
      expect(items).toHaveLength(1)
      expect(items[0]!.canonicalUrl).toBe("https://s.test/post?id=7")
      // The second observation is filed on the item that was kept.
      expect((await all(store.observations())).map((o) => o.itemId)).toEqual([items[0]!.id, items[0]!.id])
    })

    it("level 3: the same text under two urls shares one contentId", async () => {
      const store = memoryStore()
      const http = fakeHttp()
      http.respond.set(
        "https://fake.example.com/a",
        page({ posts: [one("1", "https://one.test/x", "Same words, here!"), one("2", "https://two.test/y", "same WORDS here")] }),
      )
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ newItems: 2, duplicates: 0 })
      const items = await all(store.items())
      expect(items).toHaveLength(2)
      expect(items[0]!.contentId).toBeDefined()
      expect(items[0]!.contentId).toBe(items[1]!.contentId)
      expect(report.coverage!.cells[0]).toMatchObject({ items: 2, withUniqueContent: 0 })
    })
  })

  describe("shape check", () => {
    it("fails a connector whose run returned no item", async () => {
      const http = webOf("fake.example.com", ["a"])
      const report = await createCollector({
        store: memoryStore(),
        transports: { http },
        connectors: [fakeConnector({ parse: () => ({ items: [] }) })],
      }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ status: "failed", tasks: { done: 1 } })
      expect(report.connectors[0]!.reason).toMatch(/no items/)
    })

    it("fails a connector with counters when every counter is missing", async () => {
      const http = fakeHttp()
      http.respond.set("https://fake.example.com/a", page({ posts: [{ id: "1", url: "https://s.test/1", text: "t" }] }))
      const store = memoryStore()
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ status: "failed", newItems: 1 })
      expect(report.connectors[0]!.reason).toMatch(/every counter is missing/)
      // The same output is fine for a connector that declares no counter.
      const ok = await createCollector({ store: memoryStore(), transports: { http }, connectors: [fakeConnector({ counters: false })] }).run(recipeOf(["fake"]))
      expect(ok.connectors[0]!.status).toBe("ok")
    })

    it("marks a task whose parse throws as failed with cause parse, writing nothing", async () => {
      const store = memoryStore()
      const http = webOf("fake.example.com", ["a"])
      const report = await createCollector({
        store,
        transports: { http },
        connectors: [fakeConnector({ parse: () => { throw new Error("bad shape") } })],
      }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ status: "failed", failures: { parse: 1 } })
      expect(await all(store.items())).toHaveLength(0)
      expect((await readAll(store.rawIndex())).records).toHaveLength(1)
    })
  })

  describe("scheduling", () => {
    it("runs at most one browser task at a time", async () => {
      const browser = fakeBrowser(5)
      const ids = ["a", "b", "c", "d", "e"]
      for (const id of ids) browser.respond.set(`https://fake.example.com/${id}`, { posts: [{ id, url: `https://s.test/${id}`, text: id, views: 1 }] })
      const report = await createCollector({
        store: memoryStore(),
        transports: { browser },
        connectors: [fakeConnector({ transports: ["browser"], tasks: ids })],
      }).run(recipeOf(["fake"], 8))
      expect(report.connectors[0]).toMatchObject({ status: "ok", tasks: { done: 5 } })
      expect(browser.maxConcurrent).toBe(1)
    })

    it("bounds the pool at the worker count", async () => {
      const http = fakeHttp(5)
      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`)
      webOf("fake.example.com", ids, http)
      const report = await createCollector({
        store: memoryStore(),
        transports: { http },
        connectors: [fakeConnector({ tasks: ids })],
      }).run(recipeOf(["fake"], 3))
      expect(report.connectors[0]!.tasks.done).toBe(12)
      expect(http.maxConcurrent).toBe(3)
    })

    it("uses 8 workers by default", async () => {
      const http = fakeHttp(5)
      const ids = Array.from({ length: 20 }, (_, i) => `t${i}`)
      webOf("fake.example.com", ids, http)
      await createCollector({ store: memoryStore(), transports: { http }, connectors: [fakeConnector({ tasks: ids })] }).run({
        sources: [{ connector: "fake" }],
      })
      expect(http.maxConcurrent).toBe(8)
    })

    it("starts non-browser tasks first and runs the browser queue alongside", async () => {
      const order: string[] = []
      const http = fakeHttp(5)
      webOf("web.test", ["h1", "h2"], http)
      const browser = fakeBrowser(5)
      browser.respond.set("https://br.test/b1", { posts: [{ id: "b1", url: "https://s.test/b1", text: "b1", views: 1 }] })
      const inner = browser.open.bind(browser)
      browser.open = async (u) => (order.push(`browser:${u}`), inner(u))
      const innerReq = http.request.bind(http)
      http.request = async (r) => (order.push(`http:${r.url}`), innerReq(r))
      const report = await createCollector({
        store: memoryStore(),
        transports: { http, browser },
        connectors: [
          fakeConnector({ id: "br", host: "br.test", transports: ["browser"], tasks: ["b1"] }),
          fakeConnector({ id: "web", host: "web.test", tasks: ["h1", "h2"] }),
        ],
      }).run(recipeOf(["br", "web"], 2))
      expect(report.connectors.every((c) => c.status === "ok")).toBe(true)
      expect(order.slice(0, 2)).toEqual(["http:https://web.test/h1", "http:https://web.test/h2"])
      expect(order).toContain("browser:https://br.test/b1")
    })
  })

  describe("lock", () => {
    it("throws a typed error on a locked store and releases the lock after a run", async () => {
      const store = memoryStore()
      const held = await store.acquireLock()
      const http = webOf("fake.example.com", ["a"])
      const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector()] })
      await expect(collector.run(recipeOf(["fake"]))).rejects.toBeInstanceOf(StoreLockedError)
      expect(http.calls).toHaveLength(0)
      await held.release()
      await collector.run(recipeOf(["fake"]))
      await expect(store.acquireLock().then((l) => l.release())).resolves.toBeUndefined()
    })

    it("releases the lock when the run throws", async () => {
      const store = memoryStore()
      const bad = defineConnector({ ...fakeConnector(), plan: () => { throw new Error("boom") } })
      const collector = createCollector({ store, transports: { http: fakeHttp() }, connectors: [bad] })
      await expect(collector.run(recipeOf(["fake"]))).rejects.toThrow("boom")
      await expect(store.acquireLock().then((l) => l.release())).resolves.toBeUndefined()
    })
  })

  it("runs end to end on the disk store, then resumes from a reopened store", async () => {
    const d = await testDir()
    cleanups.push(d.cleanup)
    const store = await initStore(d.path)
    const ids = ["a", "b", "c"]
    const ac = new AbortController()
    const http = fakeHttp(0, (n) => n === 1 && ac.abort())
    webOf("fake.example.com", ids, http)
    const connectors = [fakeConnector({ tasks: ids })]
    const partial = await createCollector({ store, transports: { http }, connectors }).run(recipeOf(["fake"], 1), { signal: ac.signal })
    expect(partial.connectors[0]!.status).toBe("partial")

    const reopened = await openStore(d.path)
    const final = await createCollector({ store: reopened, transports: { http }, connectors }).resume(partial.runId)
    expect(final.connectors[0]).toMatchObject({ status: "ok", tasks: { done: 3 }, newItems: 3 })
    expect(http.calls).toHaveLength(3)
    expect(await all(reopened.items())).toHaveLength(3)
    expect((await readAll(reopened.rawIndex())).records).toHaveLength(3)
    expect(await reopened.readReport(partial.runId)).toEqual(final)
    expect((await readAll(reopened.events(partial.runId))).records.at(-1)?.type).toBe("run.end")
  })
})
