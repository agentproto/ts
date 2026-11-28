import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CollectRunError,
  Recipe,
  createCollector,
  defineConnector,
  memoryStore,
  readAll,
  seenKey,
  type CollectStore,
  type HttpResponse,
  type SamplingRecord,
  type ParseResult,
} from "../index"
import { initStore, openStore } from "../node"
import { candidateDomain, createSampler, domainOf, mulberry32, type SamplingDecision } from "../sampling"
import { enc, fakeBrowser, fakeConnector, fakeHttp, page, recipeOf } from "./engine-helpers"
import { testDir } from "./helpers"

interface Row {
  id: string
  url?: string
  views?: number
  target?: string
  outbound?: string[]
  kind?: "post" | "submission"
  partAuthor?: string
  pickup?: boolean
}

const hostOf = (id: string) => `${id}.example.com`

/** A connector whose pages are `{ posts: Row[] }` and whose parse maps them to items with a views counter. */
function sampled(tasks: string[], o: { id?: string; kinds?: Record<string, string>; transports?: Array<"http" | "browser"> } = {}) {
  const id = o.id ?? "fake"
  const base = fakeConnector({
    id,
    tasks,
    transports: o.transports,
    parse: (raw): ParseResult => {
      const rows = (JSON.parse(new TextDecoder().decode(raw.bytes)) as { posts: Row[] }).posts
      return {
        items: rows.map((r) => ({
          id: `${id}:${r.id}`,
          source: id,
          kind: r.kind ?? "post",
          url: r.url ?? `https://site-${r.id}.test/${r.id}`,
          text: `text ${r.id}`,
          ...(r.target || r.kind === "submission" ? { links: r.target ? { target: r.target } : {} } : {}),
          ...(r.outbound ? { outboundLinks: r.outbound } : {}),
          ...(r.partAuthor ? { parts: [{ id: `${r.id}-p`, text: "part", authorRef: `${id}:${r.partAuthor}` }] } : {}),
          authorRef: `${id}:author-${r.id}`,
        })),
        observations: rows.map((r) => ({ itemId: `${id}:${r.id}`, metrics: r.views === undefined ? {} : { views: r.views } })),
        actors: rows.flatMap((r) => [
          { ref: `${id}:author-${r.id}`, audience: [] },
          ...(r.partAuthor ? [{ ref: `${id}:${r.partAuthor}`, audience: [] }] : []),
        ]),
        pickups: rows
          .filter((r) => r.pickup)
          .map((r) => ({
            itemId: `${id}:${r.id}`,
            kind: "crosspost" as const,
            relation: "republication" as const,
            method: "declared" as const,
            verified: true,
            outlet: "outlet",
            evidence: { excerpt: "x" },
          })),
      }
    },
  })
  return defineConnector({
    ...base,
    plan: () => tasks.map((t) => ({ id: t, ...(o.kinds?.[t] ? { kind: o.kinds[t] } : {}), params: { url: `https://${hostOf(id)}/${t}` } })),
  })
}

type Pages = Record<string, Row[] | { posts: Row[]; next?: string[] }>
const asPage = (v: Pages[string]) => (Array.isArray(v) ? { posts: v } : v)

function web(pages: Pages, id = "fake", delays: Record<string, number> = {}) {
  const http = fakeHttp()
  for (const [t, v] of Object.entries(pages)) {
    const respond = page(asPage(v) as never)
    http.respond.set(
      `https://${hostOf(id)}/${t}`,
      delays[t]
        ? async (req): Promise<HttpResponse> => {
            await new Promise((r) => setTimeout(r, delays[t]))
            return respond(req)
          }
        : respond,
    )
  }
  return http
}

const ids = async (store: CollectStore) => {
  const out: string[] = []
  for await (const i of store.items()) out.push(i.id)
  return out.sort()
}
const lines = async (store: CollectStore, runId: string) =>
  (await readAll(store.sampling(runId))).records.map(({ at: _at, ...r }) => r)

const recipe = (sampling: object, connectors = ["fake"], workers = 1) => ({ ...recipeOf(connectors, workers), sampling })
const run = (store: CollectStore, pages: Pages, sampling: object, tasks = Object.keys(pages), workers = 1) =>
  createCollector({ store, transports: { http: web(pages) }, connectors: [sampled(tasks)] }).run(recipe(sampling, ["fake"], workers))

const cand = (id: string, o: Partial<{ views: number; url: string; kind: string; target: string; outboundLinks: string[] }> = {}) => ({
  id,
  metrics: o.views === undefined ? {} : { views: o.views },
  url: o.url ?? `https://${id.replace(/\W/g, "")}.test/`,
  kind: o.kind,
  target: o.target,
  outboundLinks: o.outboundLinks,
})

describe("recipe sampling", () => {
  it("applies band quotas, out-of-band and missing-metric drops, and writes one exact line per candidate", async () => {
    const store = memoryStore()
    const report = await run(
      store,
      {
        p: [
          { id: "a", views: 5 },
          { id: "b", views: 7 },
          { id: "c", views: 50 },
          { id: "d", views: 60 },
          { id: "e", views: 70 },
          { id: "f", views: 500 },
          { id: "g" },
        ],
      },
      { bands: [{ min: 0, max: 9, quota: 1 }, { metric: "views", min: 10, max: 99, quota: 2 }] },
    )
    const dom = (id: string) => ({ url: `https://site-${id}.test/${id}`, domain: `site-${id}.test`, connector: "fake", taskId: "fake/p" })
    expect(await lines(store, report.runId)).toEqual([
      { candidate: "fake:a", decision: "kept", band: 0, ...dom("a") },
      { candidate: "fake:b", decision: "dropped", rule: "band_quota", band: 0, ...dom("b") },
      { candidate: "fake:c", decision: "kept", band: 1, ...dom("c") },
      { candidate: "fake:d", decision: "kept", band: 1, ...dom("d") },
      { candidate: "fake:e", decision: "dropped", rule: "band_quota", band: 1, ...dom("e") },
      { candidate: "fake:f", decision: "dropped", rule: "out_of_bands", ...dom("f") },
      { candidate: "fake:g", decision: "dropped", rule: "no_metric", ...dom("g") },
    ])
    expect(report.connectors[0]!.sampled).toEqual({ candidates: 7, kept: 3, dropped: { band_quota: 2, out_of_bands: 1, no_metric: 1 } })
    expect(report.connectors[0]!.newItems).toBe(3)
    expect(report.connectors[0]!.observations).toBe(3)
    // A dropped candidate leaves no item, observation, seen key (id or url) or actor; coverage counts the kept ones only.
    expect(await ids(store)).toEqual(["fake:a", "fake:c", "fake:d"])
    const obs: string[] = []
    for await (const o of store.observations()) obs.push(o.itemId)
    expect(obs.sort()).toEqual(["fake:a", "fake:c", "fake:d"])
    for (const id of ["b", "e", "f", "g"]) {
      expect(await store.seenHas(seenKey("id", `fake:${id}`))).toBe(false)
      expect(await store.seenHas(seenKey("url", `https://site-${id}.test/${id}`))).toBe(false)
    }
    expect(await store.seenHas(seenKey("url", "https://site-a.test/a"))).toBe(true)
    const actors: string[] = []
    for await (const a of store.actors()) actors.push(a.ref)
    expect(actors.sort()).toEqual(["fake:author-a", "fake:author-c", "fake:author-d"])
    expect(report.coverage!.cells.reduce((n, c) => n + c.items, 0)).toBe(3)
  })

  it("filters the pickups and the part authors of a dropped candidate", async () => {
    const store = memoryStore()
    await run(
      store,
      {
        p: [
          { id: "a", views: 1, pickup: true, partAuthor: "pa" },
          { id: "b", views: 2, pickup: true, partAuthor: "pb" },
        ],
      },
      { bands: [{ min: 0, max: 9, quota: 1 }] },
    )
    expect(await ids(store)).toEqual(["fake:a"])
    const pickups: string[] = []
    for await (const k of store.pickups()) pickups.push(k.itemId)
    expect(pickups).toEqual(["fake:a"])
    const actors: string[] = []
    for await (const a of store.actors()) actors.push(a.ref)
    expect(actors.sort()).toEqual(["fake:author-a", "fake:pa"])
  })

  it("uses the primary counter when a band names no metric, and can keep a missing metric", async () => {
    const store = memoryStore()
    const report = await run(store, { p: [{ id: "a", views: 1 }, { id: "b" }] }, { bands: [{ min: 0, max: 10 }], keepMissingMetric: true })
    expect(await ids(store)).toEqual(["fake:a", "fake:b"])
    expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision, l.band])).toEqual([
      ["fake:a", "kept", 0],
      ["fake:b", "kept", undefined],
    ])
  })

  describe("bands", () => {
    const kept = async (rows: number[], bands: object[]) => {
      const store = memoryStore()
      await run(store, { p: rows.map((v) => ({ id: `v${v}`, views: v })) }, { bands })
      return (await ids(store)).map((i) => Number(i.slice(6))).sort((x, y) => x - y)
    }
    it("includes both edges and accepts unbounded sides", async () => {
      expect(await kept([4, 5, 10, 11], [{ min: 5, max: 10 }])).toEqual([5, 10])
      expect(await kept([1, 3, 4, 100, 101], [{ max: 3 }])).toEqual([1, 3])
      expect(await kept([1, 99, 100, 5000], [{ min: 100 }])).toEqual([100, 5000])
    })
    it("lets the first matching band win even when it is full, and keeps nothing at quota 0", async () => {
      const store = memoryStore()
      const report = await run(
        store,
        { p: [{ id: "a", views: 1 }, { id: "b", views: 2 }, { id: "c", views: 50 }, { id: "d", views: 51 }] },
        { bands: [{ min: 0, max: 10, quota: 1 }, { min: 0, max: 100, quota: 5 }, { min: 40, max: 60, quota: 0 }] },
      )
      // b matches band 0 first (full): dropped, it does not spill into band 1. c and d fall in band 1 before band 2 is looked at.
      expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision, l.rule, l.band])).toEqual([
        ["fake:a", "kept", undefined, 0],
        ["fake:b", "dropped", "band_quota", 0],
        ["fake:c", "kept", undefined, 1],
        ["fake:d", "kept", undefined, 1],
      ])
      const zero = memoryStore()
      await run(zero, { p: [{ id: "a", views: 1 }] }, { bands: [{ min: 0, max: 9, quota: 0 }] })
      expect(await ids(zero)).toEqual([])
    })
    it("rejects a band whose min exceeds its max", () => {
      expect(() => Recipe.parse({ ...recipeOf(["fake"]), sampling: { bands: [{ min: 10, max: 5 }] } })).toThrow(/min must not exceed max/)
      expect(() => Recipe.parse({ ...recipeOf(["fake"]), sampling: { bands: [{ min: 5, max: 5 }, { min: 1 }, { max: 1 }] } })).not.toThrow()
    })
  })

  describe("per-domain cap", () => {
    it("caps kept items per host, www stripped, using links.target for submissions", async () => {
      const store = memoryStore()
      const report = await run(
        store,
        {
          p: [
            { id: "a", url: "https://www.news.test/1" },
            { id: "b", url: "https://news.test/2" },
            { id: "c", url: "https://other.test/1" },
            // Its own url is the aggregator's; the article host is what counts.
            { id: "s1", kind: "submission", url: "https://agg.test/s1", target: "https://other.test/x" },
            { id: "s2", kind: "submission", url: "https://agg.test/s2", target: "https://www.third.test/x" },
          ],
        },
        { perDomainCap: 1 },
      )
      expect(await ids(store)).toEqual(["fake:a", "fake:c", "fake:s2"])
      expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision, l.rule, l.domain])).toEqual([
        ["fake:a", "kept", undefined, "news.test"],
        ["fake:b", "dropped", "domain_cap", "news.test"],
        ["fake:c", "kept", undefined, "other.test"],
        ["fake:s1", "dropped", "domain_cap", "other.test"],
        ["fake:s2", "kept", undefined, "third.test"],
      ])
      expect(report.connectors[0]!.sampled).toEqual({ candidates: 5, kept: 3, dropped: { domain_cap: 2 } })
    })

    it("falls back to the outbound link when the target is an id, then to the item's own url", () => {
      const sub = { kind: "submission", url: "https://agg.test/s" }
      expect(candidateDomain({ ...cand("x", sub), target: "web:abc123", outboundLinks: ["https://Out.test./a"] })).toBe("out.test")
      expect(candidateDomain({ ...cand("x", sub), target: "web:abc123" })).toBe("agg.test")
      expect(candidateDomain({ ...cand("x", sub), target: "https://t.test/a", outboundLinks: ["https://out.test/a"] })).toBe("t.test")
      // Only submissions look at the target.
      expect(candidateDomain({ ...cand("x"), url: "https://own.test/a", target: "https://t.test/a" })).toBe("own.test")
    })

    it("lowercases and strips a trailing root dot and a leading www", () => {
      expect(domainOf("https://WWW.News.Test./a")).toBe("news.test")
      expect(domainOf("https://news.test/b")).toBe("news.test")
      expect(domainOf("not a url")).toBeUndefined()
    })

    it("counts the cap per connector", async () => {
      const store = memoryStore()
      const http = web({ p: [{ id: "a", url: "https://same.test/1" }, { id: "b", url: "https://same.test/2" }] }, "one")
      const http2 = web({ p: [{ id: "a", url: "https://same.test/3" }, { id: "b", url: "https://same.test/4" }] }, "two")
      for (const [k, v] of http2.respond) http.respond.set(k, v)
      const report = await createCollector({
        store,
        transports: { http },
        connectors: [sampled(["p"], { id: "one" }), sampled(["p"], { id: "two" })],
      }).run(recipe({ perDomainCap: 1 }, ["one", "two"]))
      expect(await ids(store)).toEqual(["one:a", "two:a"])
      expect(report.connectors.map((c) => c.sampled)).toEqual([
        { candidates: 2, kept: 1, dropped: { domain_cap: 1 } },
        { candidates: 2, kept: 1, dropped: { domain_cap: 1 } },
      ])
    })
  })

  it("does not sample tasks that read by URL", async () => {
    const store = memoryStore()
    const http = web({ list: [{ id: "a", views: 1 }, { id: "b", views: 2 }], one: [{ id: "c", views: 3 }, { id: "d", views: 4 }] })
    const report = await createCollector({ store, transports: { http }, connectors: [sampled(["list", "one"], { kinds: { one: "read" } })] }).run(
      recipe({ bands: [{ min: 0, max: 10, quota: 1 }] }),
    )
    expect(await ids(store)).toEqual(["fake:a", "fake:c", "fake:d"])
    expect(report.connectors[0]!.sampled).toMatchObject({ candidates: 2, kept: 1 })
  })

  describe("known items and aliases", () => {
    it("does not sample an item that already exists, and still records its observation", async () => {
      const store = memoryStore()
      await run(store, { p: [{ id: "a", views: 1 }] }, { perDomainCap: 5 })
      const second = await run(store, { p: [{ id: "a", views: 2 }, { id: "b", views: 3 }] }, { bands: [{ min: 0, max: 9, quota: 0 }] })
      // Quota 0 keeps nothing new, but the known item is not a candidate: it adds its observation.
      expect(await ids(store)).toEqual(["fake:a"])
      expect((await lines(store, second.runId)).map((l) => [l.candidate, l.decision])).toEqual([["fake:b", "dropped"]])
      const obs: number[] = []
      for await (const o of store.observations()) obs.push(o.metrics.views!)
      expect(obs).toEqual([1, 2])
      expect(second.connectors[0]).toMatchObject({ newItems: 0, duplicates: 1, observations: 1 })
    })

    it("one URL gives one slot, within a batch and across batches", async () => {
      const store = memoryStore()
      const report = await run(
        store,
        {
          p: [
            { id: "a", views: 1, url: "https://x.test/u" },
            { id: "a2", views: 2, url: "https://x.test/u?utm_source=z" },
            { id: "b", views: 3, url: "https://y.test/b" },
            { id: "c", views: 4, url: "https://z.test/c" },
          ],
          q: [{ id: "a3", views: 5, url: "https://x.test/u#frag" }, { id: "d", views: 6, url: "https://d.test/d" }],
        },
        { bands: [{ min: 0, max: 100, quota: 3 }] },
      )
      // a and a2 are one candidate (the higher counter represents it): 3 slots go to {a,a2}, b, c; d is over quota.
      expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision])).toEqual([
        ["fake:a2", "kept"],
        ["fake:b", "kept"],
        ["fake:c", "kept"],
        ["fake:d", "dropped"],
      ])
      expect(await ids(store)).toEqual(["fake:a", "fake:b", "fake:c"])
      expect(report.connectors[0]).toMatchObject({ newItems: 3, duplicates: 2 })
    })

    it("an alias of a dropped candidate follows its drop and writes no second line", async () => {
      const store = memoryStore()
      const report = await run(
        store,
        { p: [{ id: "a", views: 1, url: "https://x.test/1" }, { id: "b", views: 2, url: "https://y.test/2" }], q: [{ id: "b2", views: 3, url: "https://y.test/2#again" }] },
        { bands: [{ min: 0, max: 100, quota: 1 }] },
      )
      expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision])).toEqual([
        ["fake:a", "kept"],
        ["fake:b", "dropped"],
      ])
      expect(await ids(store)).toEqual(["fake:a"])
    })
  })

  describe("a repeated id in one batch", () => {
    const sampler = () => createSampler({ bands: [{ metric: "views", min: 10, max: 100 }] }, "views", [])
    const a = cand("x:1", { views: 50, url: "https://b.test/1" })
    const b = cand("x:1", { views: 1, url: "https://a.test/1" })
    it("is decided on the member with the highest value, in any order", () => {
      for (const order of [[a, b], [b, a]]) {
        const { lines: l } = sampler().plan("k", order)
        expect(l).toEqual([{ candidate: "x:1", url: "https://b.test/1", domain: "b.test", decision: "kept", band: 0 }])
      }
    })
    it("breaks a tie on the smaller URL", () => {
      const t1 = cand("x:1", { views: 20, url: "https://b.test/1" })
      const t2 = cand("x:1", { views: 20, url: "https://a.test/1" })
      for (const order of [[t1, t2], [t2, t1]]) {
        expect(sampler().plan("k", order).lines[0]).toMatchObject({ url: "https://a.test/1" })
      }
    })
  })

  describe("seed", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}`, views: 1 }))
    const pick = async (seed: number | undefined, order: Row[] = rows) => {
      const store = memoryStore()
      await run(store, { p: order }, { bands: [{ min: 0, max: 5, quota: 4 }], ...(seed === undefined ? {} : { seed }) })
      return ids(store)
    }

    it("is stable across runs and input order, and changes with another seed", async () => {
      const a = await pick(7)
      expect(a).toHaveLength(4)
      expect(await pick(7)).toEqual(a)
      expect(await pick(7, [...rows].reverse())).toEqual(a)
      const others = await Promise.all([1, 2, 3, 4, 5].map((s) => pick(s)))
      expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true)
    })

    it("pins its winners", async () => {
      expect(await pick(7)).toEqual(PINNED_SEED_7)
      expect(await pick(8)).toEqual(PINNED_SEED_8)
    })

    it("keeps the first seen in plan order without a seed", async () => {
      expect(await pick(undefined)).toEqual(["fake:r00", "fake:r01", "fake:r02", "fake:r03"])
    })

    it("mulberry32 gives the known sequence for seed 5", () => {
      const r = mulberry32(5)
      expect([r(), r(), r()].map((v) => v * 4294967296)).toEqual([2962560684, 3318907087, 943874942])
    })
  })

  describe("ordered commit", () => {
    const rows = (t: string, n = 2): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${t}-${i}`, views: 1 }))
    const sampling = { bands: [{ min: 0, max: 9, quota: 5 }], perDomainCap: 3, seed: 3 }

    it("keeps the same set whatever the completion order, with workers above 1", async () => {
      const pages: Pages = {
        t1: { posts: rows("t1"), next: ["t1b"] },
        t1b: rows("t1b"),
        t2: rows("t2"),
        t3: rows("t3"),
        t4: rows("t4"),
      }
      const make = async (workers: number, delays: Record<string, number>) => {
        const store = memoryStore()
        const http = web(pages, "fake", delays)
        const report = await createCollector({ store, transports: { http }, connectors: [sampled(["t1", "t2", "t3", "t4"])] }).run(
          recipe(sampling, ["fake"], workers),
        )
        return { ids: await ids(store), http, report, lines: await lines(store, report.runId) }
      }
      const serial = await make(1, {})
      expect(serial.ids).toHaveLength(5)
      // The earliest task is the slowest, a later one finishes first.
      const inverted = await make(4, { t1: 60, t1b: 40, t2: 30 })
      expect(inverted.http.maxConcurrent).toBeGreaterThan(1)
      expect(inverted.ids).toEqual(serial.ids)
      expect(inverted.lines.map((l) => [l.candidate, l.decision])).toEqual(serial.lines.map((l) => [l.candidate, l.decision]))
      // The slow first tasks win the quota: t1, t1b then t2's first.
      expect(serial.ids).toEqual(["fake:t1-0", "fake:t1-1", "fake:t1b-0", "fake:t1b-1", "fake:t2-0"])
    })

    it("holds with a task in fallback in the browser lane and a failed task", async () => {
      const pages: Pages = { t0: rows("t0"), t1: rows("t1"), t2: rows("t2"), t3: rows("t3") }
      const make = async (workers: number, browserDelay: number) => {
        const store = memoryStore()
        const http = web(pages, "fake", workers > 1 ? { t2: 5 } : {})
        http.respond.delete("https://fake.example.com/t0") // t0 fails: a terminal failure advances the cursor
        http.respond.set("https://fake.example.com/t1", () => ({ status: 403, headers: {}, body: enc("no"), url: "https://fake.example.com/t1" }))
        const browser = fakeBrowser(browserDelay)
        browser.respond.set("https://fake.example.com/t1", { posts: rows("t1") as never })
        const report = await createCollector({
          store,
          transports: { http, browser },
          connectors: [sampled(["t0", "t1", "t2", "t3"], { transports: ["http", "browser"] })],
        }).run(recipe({ bands: [{ min: 0, max: 9, quota: 3 }] }, ["fake"], workers))
        return { ids: await ids(store), report }
      }
      const serial = await make(1, 0)
      expect(serial.ids).toEqual(["fake:t1-0", "fake:t1-1", "fake:t2-0"])
      const mixed = await make(4, 50)
      expect(mixed.ids).toEqual(serial.ids)
      expect(mixed.report.connectors[0]).toMatchObject({ tasks: { done: 3, failed: 1 }, escalations: [{ from: "http", to: "browser", count: 1 }] })
    })
  })

  describe("durable decisions", () => {
    const pages: Pages = {
      t1: [{ id: "a", views: 1 }, { id: "b", views: 1 }, { id: "c", views: 1 }],
      t2: [{ id: "d", views: 1 }, { id: "e", views: 1 }, { id: "f", views: 1 }],
      t3: [{ id: "g", views: 1 }, { id: "h", views: 1 }],
    }
    const sampling = { bands: [{ min: 0, max: 9, quota: 5 }], seed: 9 }
    const reference = async () => {
      const store = memoryStore()
      const report = await run(store, pages, sampling)
      return { ids: await ids(store), lines: (await lines(store, report.runId)).map((l) => [l.candidate, l.decision]) }
    }

    it("stops and surfaces a run error when the decisions cannot be persisted, and moves no counter", async () => {
      const base = memoryStore()
      const store: CollectStore = {
        ...base,
        appendSamplingBatch: async () => {
          throw new Error("disk gone")
        },
      }
      const collector = createCollector({ store, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] })
      await expect(collector.run(recipe(sampling), { runId: "nojournal" })).rejects.toBeInstanceOf(CollectRunError)
      expect(await ids(store)).toEqual([])
      expect((await readAll(store.sampling("nojournal"))).records).toHaveLength(0)
      expect(Object.values(await taskStates(store, "nojournal"))).not.toContain("done")
    })

    it("resumes after a crash in the middle of the journal (a torn append)", async () => {
      const d = await testDir()
      try {
        const base = await initStore(d.path)
        let calls = 0
        const torn = async (runId: string, rs: SamplingRecord[]) => {
          if (++calls < 2) return base.appendSamplingBatch(runId, rs)
          // Second task: the first line lands, the next one is cut in half.
          await base.appendSamplingBatch(runId, rs.slice(0, 1))
          await appendFile(join(d.path, "runs", runId, "sampling.jsonl"), `${JSON.stringify(rs[1]).slice(0, 25)}`)
          throw new Error("power cut")
        }
        const store = new Proxy(base, {
          get: (t, k) => (k === "appendSamplingBatch" ? torn : typeof t[k as keyof typeof t] === "function" ? (t[k as keyof typeof t] as () => unknown).bind(t) : t[k as keyof typeof t]),
        }) as CollectStore
        const collector = createCollector({ store, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] })
        await expect(collector.run(recipe(sampling), { runId: "torn" })).rejects.toBeInstanceOf(CollectRunError)
        const reopened = await openStore(d.path)
        const resumed = await createCollector({ store: reopened, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] }).resume("torn")
        const ref = await reference()
        expect(await ids(reopened)).toEqual(ref.ids)
        expect((await lines(reopened, "torn")).map((l) => [l.candidate, l.decision])).toHaveLength(ref.lines.length)
        expect(new Set((await lines(reopened, "torn")).map((l) => l.candidate)).size).toBe(ref.lines.length)
        expect(resumed.connectors[0]!.tasks.done).toBe(3)
      } finally {
        await d.cleanup()
      }
    })

    it("reuses persisted decisions after a crash between the decisions and done, and decides a new candidate fresh", async () => {
      const base = memoryStore()
      let crash = true
      const store: CollectStore = {
        ...base,
        appendTask: async (id, t) => {
          if (crash && t.status === "done" && t.taskId === "fake/t2") {
            crash = false
            throw new Error("disk gone")
          }
          return base.appendTask(id, t)
        },
      }
      const collector = createCollector({ store, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] })
      await expect(collector.run(recipe(sampling), { runId: "crashy" })).rejects.toBeInstanceOf(CollectRunError)
      const journaled = (await lines(store, "crashy")).length
      expect(journaled).toBe(6)
      const resumed = await collector.resume("crashy")
      const ref = await reference()
      expect(await ids(store)).toEqual(ref.ids)
      expect((await lines(store, "crashy")).map((l) => [l.candidate, l.decision])).toEqual(ref.lines)
      expect(resumed.connectors[0]).toMatchObject({ status: "ok", tasks: { done: 3 } })

      // A page that changed between the attempts: the stranded decision stays, the new candidate is decided fresh.
      const base2 = memoryStore()
      let crash2 = true
      const store2: CollectStore = {
        ...base2,
        appendTask: async (id, t) => {
          if (crash2 && t.status === "done" && t.taskId === "fake/t1") {
            crash2 = false
            throw new Error("disk gone")
          }
          return base2.appendTask(id, t)
        },
      }
      const changed: Pages = { ...pages, t1: [{ id: "a", views: 1 }, { id: "b", views: 1 }, { id: "z", views: 1 }] }
      const c2 = createCollector({ store: store2, transports: { http: web(pages) }, connectors: [sampled(["t1"])] })
      await expect(c2.run(recipe({ bands: [{ min: 0, max: 9 }] }), { runId: "changed" })).rejects.toBeInstanceOf(CollectRunError)
      const c3 = createCollector({ store: store2, transports: { http: web(changed) }, connectors: [sampled(["t1"])] })
      await c3.resume("changed")
      expect((await lines(store2, "changed")).map((l) => l.candidate).sort()).toEqual(["fake:a", "fake:b", "fake:c", "fake:z"])
    })
  })

  describe("resume", () => {
    const pages = {
      t1: [{ id: "a", views: 1, url: "https://d.test/a" }, { id: "b", views: 2, url: "https://d.test/b" }, { id: "c", views: 3 }],
      t2: [{ id: "d", views: 4, url: "https://d.test/d" }, { id: "e", views: 5 }, { id: "f", views: 6 }],
      t3: [{ id: "g", views: 7, url: "https://d.test/g" }, { id: "h", views: 8 }, { id: "i", views: 9 }],
    }
    const sampling = { bands: [{ min: 0, max: 100, quota: 5 }], perDomainCap: 2, seed: 11 }

    it("an interrupted run, resumed, keeps the same set as an uninterrupted one", async () => {
      const whole = memoryStore()
      await run(whole, pages, sampling, ["t1", "t2", "t3"])

      const store = memoryStore()
      const ctl = new AbortController()
      const collector = createCollector({ store, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] })
      const first = await collector.run(recipe(sampling), {
        signal: ctl.signal,
        onEvent: (e) => {
          if (e.type === "task.end") ctl.abort()
        },
      })
      expect(first.connectors[0]!.tasks.done).toBe(1)
      const resumed = await collector.resume(first.runId)
      expect(resumed.connectors[0]!.tasks.done).toBe(3)
      expect(await ids(store)).toEqual(await ids(whole))
      expect(resumed.connectors[0]!.sampled).toEqual({ candidates: 9, kept: 5, dropped: { band_quota: 3, domain_cap: 1 } })
      expect((await lines(store, resumed.runId)).length).toBe(9)
    })

    it("restores the domain counter and the band counter independently", () => {
      const at = (o: Partial<SamplingDecision>): SamplingDecision => ({ candidate: "p", decision: "kept", ...o })
      const onlyDomain = createSampler({ perDomainCap: 1 }, "views", [at({ domain: "d.test" })])
      expect(onlyDomain.plan("k", [cand("a", { url: "https://d.test/1" })]).lines[0]).toMatchObject({ decision: "dropped", rule: "domain_cap" })
      expect(onlyDomain.plan("k", [cand("b", { url: "https://e.test/1" })]).lines[0]).toMatchObject({ decision: "kept" })
      const onlyBand = createSampler({ bands: [{ min: 0, max: 9, quota: 1 }] }, "views", [at({ band: 0 })])
      expect(onlyBand.plan("k", [cand("a", { views: 1 })]).lines[0]).toMatchObject({ decision: "dropped", rule: "band_quota" })
      // A dropped line moves no counter.
      const dropped = createSampler({ bands: [{ min: 0, max: 9, quota: 1 }], perDomainCap: 1 }, "views", [at({ decision: "dropped", rule: "band_quota", band: 0, domain: "d.test" })])
      expect(dropped.plan("k", [cand("a", { views: 1, url: "https://d.test/1" })]).lines[0]).toMatchObject({ decision: "kept" })
    })

    it("applies counters only on apply", () => {
      const s = createSampler({ bands: [{ min: 0, max: 9, quota: 1 }] }, "views", [])
      const first = s.plan("k", [cand("a", { views: 1 })])
      expect(s.plan("k", [cand("b", { views: 1 })]).lines[0]).toMatchObject({ decision: "kept" })
      s.apply(first.lines)
      expect(s.plan("k", [cand("b", { views: 1 })]).lines[0]).toMatchObject({ decision: "dropped", rule: "band_quota" })
      expect(s.plan("k", [cand("a", { views: 1 })]).lines).toEqual([])
    })
  })
})

const PINNED_SEED_7 = ["fake:r00", "fake:r02", "fake:r08", "fake:r10"]
const PINNED_SEED_8 = ["fake:r04", "fake:r06", "fake:r09", "fake:r10"]

async function taskStates(store: CollectStore, runId: string) {
  return Object.fromEntries((await readAll(store.tasks(runId))).records.map((t) => [t.taskId, t.status]))
}
