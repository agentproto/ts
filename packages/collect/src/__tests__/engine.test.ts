import { afterEach, describe, expect, it } from "vitest"
import {
  type CollectStore,
  CollectRunError,
  StoreLockedError,
  seenKey,
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
    expect(first.connectors[0]).toMatchObject({ status: "partial", failures: { http: 1 } })
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

  it("falls back on an empty body and a thrown blocked error", async () => {
    const http = fakeHttp()
    http.respond.set("https://fake.example.com/e", () => ({ status: 200, headers: {}, body: new Uint8Array(), url: "x" }))
    http.respond.set("https://fake.example.com/t", () => {
      throw new TransportError("blocked", "blocked", { status: 429, url: "https://fake.example.com/t", body: enc("slow down"), ext: "html" })
    })
    const browser = fakeBrowser()
    for (const id of ["e", "t"]) {
      browser.respond.set(`https://fake.example.com/${id}`, { posts: [{ id, url: `https://site.test/${id}`, text: id, views: 1 }] })
    }
    const store = memoryStore()
    const report = await createCollector({
      store,
      transports: { http, browser },
      connectors: [fakeConnector({ transports: ["http", "browser"], tasks: ["e", "t"] })],
    }).run(recipeOf(["fake"]))
    expect(report.connectors[0]).toMatchObject({ status: "ok", newItems: 2, escalations: [{ from: "http", to: "browser", count: 2 }] })
    const causes = (await readAll(store.rawIndex())).records.filter((r) => r.failure).map((r) => r.failure).sort()
    expect(causes).toEqual(["blocked", "empty"])
  })

  it("stops a connector on a challenge: no fallback, raw kept, queued tasks skipped", async () => {
    const store = memoryStore()
    const http = webOf("other.example.com", ["o1"])
    http.respond.set("https://fake.example.com/c1", () => ({ status: 200, headers: {}, body: enc("<html>verify you are human</html>"), url: "https://fake.example.com/c1" }))
    webOf("fake.example.com", ["c2", "c3"], http)
    const browser = fakeBrowser()
    const base = fakeConnector({ transports: ["http", "browser"], tasks: ["c1", "c2", "c3"] })
    const connector = defineConnector({
      ...base,
      fetch: async (task, transport, ctx) => {
        const r = await base.fetch(task, transport, ctx)
        if (task.id === "c1") r.raws[0]!.challenge = true
        return r
      },
    })
    const report = await createCollector({
      store,
      transports: { http, browser },
      connectors: [connector, fakeConnector({ id: "other", host: "other.example.com", tasks: ["o1"] })],
    }).run(recipeOf(["fake", "other"], 1))
    const by = Object.fromEntries(report.connectors.map((c) => [c.connector, c]))
    expect(by.fake).toMatchObject({ status: "failed", tasks: { planned: 3, done: 0, failed: 1, skipped: 2 }, escalations: [], failures: { blocked: 1 } })
    expect(by.fake!.reason).toMatch(/challenge/)
    expect(by.other!.status).toBe("ok")
    expect(browser.opened).toEqual([])
    expect(http.calls.map((c) => c.url)).toEqual(["https://fake.example.com/c1", "https://other.example.com/o1"])
    const tasks = (await readAll(store.tasks(report.runId))).records
    expect(tasks.filter((t) => t.status === "skipped").map((t) => t.reason)).toEqual(["challenge", "challenge"])
    const raw = (await readAll(store.rawIndex())).records.find((r) => r.failure)
    expect(raw).toMatchObject({ failure: "blocked", transport: "http" })
    expect(new TextDecoder().decode(await store.getRaw(raw!.ref))).toContain("verify")
    expect((await readAll(store.events(report.runId))).records.some((e) => e.type === "connector.stopped")).toBe(true)
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
    // Resume keeps the recorded global order.
    expect(http2.calls.map((c) => c.url.split("/").pop())).toEqual(["a", "a2", "a1", "b", "b1"])
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

  describe("idempotent ingest", () => {
    it("a crash after the writes and before done leaves the counts unchanged on resume", async () => {
      const base = memoryStore()
      let crash = true
      const store: CollectStore = {
        ...base,
        appendTask: async (id, t) => {
          if (crash && t.status === "done") {
            crash = false
            throw new Error("disk gone")
          }
          return base.appendTask(id, t)
        },
      }
      const http = webOf("fake.example.com", ["a", "b"])
      const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b"] })] })
      await expect(collector.run(recipeOf(["fake"], 1), { runId: "crashy" })).rejects.toBeInstanceOf(CollectRunError)
      // The writes of the first task are on disk, its done marker is not.
      expect(await all(store.items())).toHaveLength(1)
      expect(await all(store.observations())).toHaveLength(1)

      const report = await collector.resume("crashy")
      expect(await all(store.items())).toHaveLength(2)
      expect(await all(store.observations())).toHaveLength(2)
      expect(report.connectors[0]).toMatchObject({ status: "ok", tasks: { planned: 2, done: 2 }, newItems: 2, observations: 2, duplicates: 0 })
      expect(http.calls).toHaveLength(3) // the redone task is fetched again
    })

    it("validates every raw of a task before writing any of them", async () => {
      const store = memoryStore()
      const http = webOf("fake.example.com", ["a"])
      const base = fakeConnector({ tasks: ["a"] })
      const connector = defineConnector({
        ...base,
        fetch: async (task, transport, ctx) => {
          const r = await base.fetch(task, transport, ctx)
          r.raws.push({ ...r.raws[0]!, url: "https://fake.example.com/second", ext: "bad" })
          return r
        },
        parse: (input) => {
          if (input.raw.ext === "bad") return { items: [{ id: "fake:bad", source: "fake", kind: "nonsense" as never }] }
          return base.parse(input)
        },
      })
      const report = await createCollector({ store, transports: { http }, connectors: [connector] }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ status: "failed", failures: { parse: 1 } })
      expect(await all(store.items())).toHaveLength(0)
      expect(await all(store.observations())).toHaveLength(0)
      expect((await readAll(store.rawIndex())).records).toHaveLength(2)
    })
  })

  describe("seen index owners", () => {
    it("resolves an orphan item (seen write lost) through its url, and files observations on the owner", async () => {
      const store = memoryStore()
      await store.upsertItem({ id: "fake:old", source: "fake", kind: "post", subjects: [], firstSeenAt: "2026-11-01T00:00:00Z", url: "https://s.test/p", canonicalUrl: "https://s.test/p" })
      expect(await store.seenHas(seenKey("url", "https://s.test/p"))).toBe(false)
      const http = fakeHttp()
      http.respond.set("https://fake.example.com/a", page({ posts: [{ id: "2", url: "https://s.test/p?utm_source=x", text: "later", views: 7 }] }))
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).run(recipeOf(["fake"]))
      expect(report.connectors[0]).toMatchObject({ newItems: 0, duplicates: 1, observations: 1 })
      expect(await all(store.items())).toHaveLength(1)
      expect((await all(store.observations())).map((o) => o.itemId)).toEqual(["fake:old"])
      expect(await store.seenGet(seenKey("id", "fake:old"))).toBe("fake:old")
      expect(await store.seenGet(seenKey("id", "fake:2"))).toBe("fake:old")
      expect(await store.seenGet(seenKey("url", "https://s.test/p"))).toBe("fake:old")
    })

    it("records an owner for every key of a new item and resolves links through aliases", async () => {
      const store = memoryStore()
      const http = webOf("fake.example.com", ["a"])
      const connector = fakeConnector({
        parse: () => ({
          items: [
            { id: "fake:1", source: "fake", kind: "post", url: "https://s.test/u?utm_source=a", text: "one" },
            { id: "fake:2", source: "fake", kind: "post", url: "https://s.test/u", text: "two" },
            { id: "fake:3", source: "fake", kind: "post", url: "https://s.test/v", text: "three", links: { target: "fake:2" } },
          ],
          observations: [{ itemId: "fake:2", metrics: { views: 3 } }],
        }),
      })
      await createCollector({ store, transports: { http }, connectors: [connector] }).run(recipeOf(["fake"]))
      expect(await store.seenGet(seenKey("id", "fake:1"))).toBe("fake:1")
      expect(await store.seenGet(seenKey("url", "https://s.test/u"))).toBe("fake:1")
      expect((await store.getItem("fake:3"))?.links?.target).toBe("fake:1")
      expect((await all(store.observations())).map((o) => o.itemId)).toEqual(["fake:1"])
    })
  })

  describe("plan and resume", () => {
    it("writes the root plan with global order keys, across connectors", async () => {
      const store = memoryStore()
      const http = fakeHttp()
      webOf("a.example.com", ["a1", "a2"], http)
      webOf("b.example.com", ["b1", "b2"], http)
      const connectors = [fakeConnector({ id: "ca", host: "a.example.com", tasks: ["a1", "a2"] }), fakeConnector({ id: "cb", host: "b.example.com", tasks: ["b1", "b2"] })]
      const report = await createCollector({ store, transports: { http }, connectors }).run(recipeOf(["cb", "ca"], 1))
      expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["b1", "b2", "a1", "a2"])
      expect((await store.readPlan(report.runId))?.map((p) => [p.taskId, p.order])).toEqual([
        ["cb/b1", [0, 0]],
        ["cb/b2", [0, 1]],
        ["ca/a1", [1, 0]],
        ["ca/a2", [1, 1]],
      ])
    })

    it("keeps the global start order after a resume", async () => {
      const store = memoryStore()
      const ac = new AbortController()
      const http = fakeHttp(0, (n) => n === 1 && ac.abort())
      webOf("a.example.com", ["a1", "a2"], http)
      webOf("b.example.com", ["b1", "b2"], http)
      const connectors = [fakeConnector({ id: "ca", host: "a.example.com", tasks: ["a1", "a2"] }), fakeConnector({ id: "cb", host: "b.example.com", tasks: ["b1", "b2"] })]
      const collector = createCollector({ store, transports: { http }, connectors })
      const partial = await collector.run(recipeOf(["ca", "cb"], 1), { signal: ac.signal })
      await collector.resume(partial.runId)
      expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["a1", "a2", "b1", "b2"])
    })

    it("resumes from the plan alone when no task was recorded yet", async () => {
      const store = memoryStore()
      await store.createRun("planned", recipeOf(["fake"]) as never)
      await store.writePlan("planned", [{ taskId: "fake/a", connector: "fake", order: [0, 0], payload: { id: "a", params: { url: "https://fake.example.com/a" } } }])
      const http = webOf("fake.example.com", ["a"])
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).resume("planned")
      expect(report.connectors[0]).toMatchObject({ status: "ok", tasks: { planned: 1, done: 1 } })
    })

    it("reports tasks of a connector that is no longer registered as skipped", async () => {
      const store = memoryStore()
      const http = webOf("fake.example.com", ["a"])
      const gone = fakeConnector({ id: "gone", tasks: ["g1", "g2"] })
      const ac = new AbortController()
      ac.abort()
      const first = await createCollector({ store, transports: { http }, connectors: [fakeConnector(), gone] }).run(recipeOf(["fake", "gone"]), { signal: ac.signal })
      expect(first.connectors.map((c) => c.tasks.planned)).toEqual([1, 2])
      const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).resume(first.runId)
      const by = Object.fromEntries(report.connectors.map((c) => [c.connector, c]))
      expect(by.fake!.status).toBe("ok")
      expect(by.gone).toMatchObject({ status: "skipped", tasks: { planned: 2, skipped: 2, done: 0 } })
      expect(by.gone!.skippedReason).toMatch(/not registered/)
    })

    it("restores the caps on resume: a retried failed task takes no new budget", async () => {
      const store = memoryStore()
      const http = fakeHttp()
      webOf("fake.example.com", ["b", "c"], http)
      http.respond.set("https://fake.example.com/a", page({ posts: [] }, 500))
      const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b", "c"], maxTasksPerRun: 2 })] })
      const first = await collector.run(recipeOf(["fake"], 1))
      expect(first.connectors[0]).toMatchObject({ tasks: { done: 1, failed: 1, skipped: 1 } })
      webOf("fake.example.com", ["a"], http)
      const second = await collector.resume(first.runId)
      expect(second.connectors[0]).toMatchObject({ tasks: { planned: 3, done: 2, failed: 0, skipped: 1 } })
      expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["a", "b", "a"]) // c never fetched
    })

    it("restores the total cap on resume", async () => {
      const store = memoryStore()
      const http = webOf("fake.example.com", ["a", "b", "c"])
      const collector = createCollector({ store, transports: { http }, connectors: [fakeConnector({ tasks: ["a", "b", "c"] })] })
      const first = await collector.run({ ...recipeOf(["fake"], 1), caps: { total: 2 } })
      expect(first.connectors[0]).toMatchObject({ tasks: { done: 2, skipped: 1 } })
      const second = await collector.resume(first.runId)
      expect(second.connectors[0]).toMatchObject({ tasks: { done: 2, skipped: 1 } })
      expect(http.calls).toHaveLength(2)
    })
  })

  describe("per-host gate", () => {
    const startsOf = async (specs: Array<{ id: string; paceMs: number; tasks: string[] }>, late = 0) => {
      const clock = fakeClock(undefined, late)
      const t0 = clock.now()
      const http = fakeHttp()
      const starts: number[] = []
      const inner = http.request.bind(http)
      http.request = async (r) => (starts.push(clock.now() - t0), inner(r))
      for (const sp of specs) webOf("shared.test", sp.tasks, http)
      const connectors = specs.map((sp) => fakeConnector({ id: sp.id, host: "shared.test", tasks: sp.tasks, paceMs: sp.paceMs }))
      await createCollector({ store: memoryStore(), transports: { http }, connectors, clock }).run(recipeOf(specs.map((x) => x.id), 4))
      return { starts, clock, http }
    }

    it("spaces a fast connector after a slow one by the slower interval", async () => {
      const { starts } = await startsOf([{ id: "slow", paceMs: 1000, tasks: ["s1"] }, { id: "fast", paceMs: 0, tasks: ["f1", "f2"] }])
      expect(starts).toEqual([0, 1000, 1000])
    })

    it("applies the interval of the connector that asks, after a fast one", async () => {
      const { starts } = await startsOf([{ id: "fast", paceMs: 0, tasks: ["f1"] }, { id: "slow", paceMs: 1000, tasks: ["s1", "s2"] }])
      expect(starts).toEqual([0, 1000, 2000])
    })

    it("measures again at wake-up when the clock wakes late", async () => {
      const { starts } = await startsOf([{ id: "c", paceMs: 1000, tasks: ["a", "b", "c"] }], 300)
      expect(starts).toEqual([0, 1300, 2600])
    })

    it("serves zero-delay connectors through the same FIFO without waiting", async () => {
      const { starts, clock, http } = await startsOf([{ id: "x", paceMs: 0, tasks: ["a", "b"] }, { id: "y", paceMs: 0, tasks: ["c"] }])
      expect(starts).toEqual([0, 0, 0])
      expect(clock.sleeps).toEqual([])
      expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["a", "b", "c"])
    })
  })

  describe("lanes", () => {
    it("a fallback moves the task from the pool to the browser lane and frees its worker", async () => {
      const log: string[] = []
      const http = fakeHttp()
      http.respond.set("https://one.test/t1", page({ posts: [] }, 403))
      webOf("two.test", ["t2"], http)
      const inner = http.request.bind(http)
      http.request = async (r) => (log.push(`http:${r.url.split("/").pop()}`), inner(r))
      const browser = fakeBrowser(30)
      browser.respond.set("https://one.test/t1", { posts: [{ id: "t1", url: "https://s.test/t1", text: "t1", views: 1 }] })
      const ev = browser.evaluate.bind(browser)
      browser.evaluate = (async (p: never, s: string) => {
        const r = await ev(p, s)
        log.push("browser-end")
        return r
      }) as typeof browser.evaluate
      const report = await createCollector({
        store: memoryStore(),
        transports: { http, browser },
        connectors: [
          fakeConnector({ id: "one", host: "one.test", transports: ["http", "browser"], tasks: ["t1"] }),
          fakeConnector({ id: "two", host: "two.test", tasks: ["t2"] }),
        ],
      }).run(recipeOf(["one", "two"], 1))
      expect(report.connectors.every((c) => c.status === "ok")).toBe(true)
      expect(log).toEqual(["http:t1", "http:t2", "browser-end"])
      expect(browser.maxConcurrent).toBe(1)
    })

    it("leaves a queued attempt pending when the run is cancelled before its slot", async () => {
      const store = memoryStore()
      const ac = new AbortController()
      const http = fakeHttp(0, (n) => n === 1 && ac.abort())
      http.respond.set("https://fake.example.com/a", page({ posts: [] }, 403))
      const browser = fakeBrowser()
      const report = await createCollector({
        store,
        transports: { http, browser },
        connectors: [fakeConnector({ transports: ["http", "browser"], tasks: ["a"] })],
      }).run(recipeOf(["fake"]), { signal: ac.signal })
      expect(browser.opened).toEqual([])
      expect(report.connectors[0]).toMatchObject({ status: "partial", tasks: { planned: 1, done: 0, failed: 0 } })
      expect((await readAll(store.tasks(report.runId))).records[0]!.status).toBe("pending")
    })
  })

  describe("store failures", () => {
    const failing = (base: CollectStore, afterEvents: number): CollectStore => {
      let n = 0
      return {
        ...base,
        appendEvent: async (id, e) => {
          if (++n > afterEvents) throw new Error("event log gone")
          return base.appendEvent(id, e)
        },
      }
    }

    it.each([0, 3])("surfaces a failing event log as a run error, with no unhandled rejection (after %i events)", async (after) => {
      const unhandled: unknown[] = []
      const on = (e: unknown) => unhandled.push(e)
      process.on("unhandledRejection", on)
      try {
        const base = memoryStore()
        const ids = ["a", "b", "c", "d", "e", "f"]
        const http = webOf("fake.example.com", ids, fakeHttp(2))
        const collector = createCollector({ store: failing(base, after), transports: { http }, connectors: [fakeConnector({ tasks: ids })] })
        const err = await collector.run(recipeOf(["fake"], 3)).catch((e) => e)
        expect(err).toBeInstanceOf(CollectRunError)
        expect(String(err.message)).toMatch(/event log gone/)
        await new Promise((r) => setTimeout(r, 30))
        expect(unhandled).toEqual([])
        await expect(base.acquireLock().then((l) => l.release())).resolves.toBeUndefined()
      } finally {
        process.off("unhandledRejection", on)
      }
    })
  })

  describe("classification by status", () => {
    const run = async (respond: (r: { url: string }) => { status: number; body: Uint8Array }, transports: Array<"http" | "browser"> = ["http", "browser"]) => {
      const store = memoryStore()
      const http = fakeHttp()
      http.respond.set("https://fake.example.com/a", (r) => ({ ...respond(r), headers: {}, url: r.url }))
      const browser = fakeBrowser()
      const report = await createCollector({ store, transports: { http, browser }, connectors: [fakeConnector({ transports, tasks: ["a"] })] }).run(recipeOf(["fake"]))
      return { report, browser, store }
    }

    it.each([404, 500])("a bodyless %i is an http failure, with no fallback", async (status) => {
      const { report, browser, store } = await run(() => ({ status, body: new Uint8Array() }))
      expect(browser.opened).toEqual([])
      expect(report.connectors[0]).toMatchObject({ status: "failed", failures: { http: 1 }, escalations: [] })
      expect((await readAll(store.rawIndex())).records[0]).toMatchObject({ httpStatus: status, failure: "http" })
    })

    it("a bodyless 200 is empty and falls back", async () => {
      const { report, browser } = await run(() => ({ status: 200, body: new Uint8Array() }))
      expect(browser.opened).toHaveLength(1)
      expect(report.connectors[0]!.escalations).toEqual([{ from: "http", to: "browser", count: 1 }])
    })

    it("records the transport actually attempted when a failure ends the task", async () => {
      const http = fakeHttp()
      http.respond.set("https://fake.example.com/a", () => {
        throw new TransportError("network", "reset")
      })
      const store = memoryStore()
      const report = await createCollector({
        store,
        transports: { http, browser: fakeBrowser() },
        connectors: [fakeConnector({ transports: ["http", "browser"] })],
      }).run(recipeOf(["fake"]))
      expect((await readAll(store.tasks(report.runId))).records[0]).toMatchObject({ status: "failed", transport: "http", cause: "network" })
    })
  })

  it("warns that sampling is not implemented and runs the recipe anyway", async () => {
    const store = memoryStore()
    const http = webOf("fake.example.com", ["a"])
    const report = await createCollector({ store, transports: { http }, connectors: [fakeConnector()] }).run({ ...recipeOf(["fake"]), sampling: { seed: 1 } })
    expect(report.connectors[0]!.status).toBe("ok")
    expect((await readAll(store.events(report.runId))).records.some((e) => e.type === "warning")).toBe(true)
  })
})
