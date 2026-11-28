import { describe, expect, it } from "vitest"
import { createCollector, defineConnector, memoryStore, readAll, seenKey, type CollectStore, type ParseResult } from "../index"
import { createSampler, mulberry32 } from "../sampling"
import { fakeConnector, fakeHttp, page, recipeOf } from "./engine-helpers"

interface Row {
  id: string
  url?: string
  views?: number
  target?: string
  kind?: "post" | "submission"
}

const HOST = "fake.example.com"

/** A connector whose pages are `{ rows }` and whose parse maps them to items with a views counter. */
function sampled(tasks: string[], kinds: Record<string, string> = {}) {
  const base = fakeConnector({
    tasks,
    parse: (raw): ParseResult => {
      const rows = (JSON.parse(new TextDecoder().decode(raw.bytes)) as { posts: Row[] }).posts
      return {
        items: rows.map((r) => ({
          id: `fake:${r.id}`,
          source: "fake",
          kind: r.kind ?? "post",
          url: r.url ?? `https://site-${r.id}.test/${r.id}`,
          text: `text ${r.id}`,
          ...(r.target ? { links: { target: r.target } } : {}),
          authorRef: `fake:author-${r.id}`,
        })),
        observations: rows.map((r) => ({ itemId: `fake:${r.id}`, metrics: r.views === undefined ? {} : { views: r.views } })),
        actors: rows.map((r) => ({ ref: `fake:author-${r.id}`, audience: [] })),
      }
    },
  })
  return defineConnector({ ...base, plan: () => tasks.map((t) => ({ id: t, ...(kinds[t] ? { kind: kinds[t] } : {}), params: { url: `https://${HOST}/${t}` } })) })
}

function web(pages: Record<string, Row[]>) {
  const http = fakeHttp()
  for (const [t, posts] of Object.entries(pages)) {
    http.respond.set(`https://${HOST}/${t}`, page({ posts } as never))
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

const recipe = (sampling: object) => ({ ...recipeOf(["fake"], 1), sampling })

describe("recipe sampling", () => {
  it("applies band quotas, out-of-band and missing-metric drops, and writes one exact line per candidate", async () => {
    const store = memoryStore()
    const http = web({
      p: [
        { id: "a", views: 5 },
        { id: "b", views: 7 },
        { id: "c", views: 50 },
        { id: "d", views: 60 },
        { id: "e", views: 70 },
        { id: "f", views: 500 },
        { id: "g" },
      ],
    })
    const report = await createCollector({ store, transports: { http }, connectors: [sampled(["p"])] }).run(
      recipe({ bands: [{ min: 0, max: 9, quota: 1 }, { metric: "views", min: 10, max: 99, quota: 2 }] }),
    )
    const dom = (id: string) => ({ domain: `site-${id}.test`, connector: "fake", taskId: "fake/p" })
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
    // A dropped candidate leaves no item, observation, seen key or actor, and coverage counts the kept ones only.
    expect(await ids(store)).toEqual(["fake:a", "fake:c", "fake:d"])
    const obs: string[] = []
    for await (const o of store.observations()) obs.push(o.itemId)
    expect(obs.sort()).toEqual(["fake:a", "fake:c", "fake:d"])
    for (const id of ["fake:b", "fake:e", "fake:f", "fake:g"]) expect(await store.seenHas(seenKey("id", id))).toBe(false)
    const actors: string[] = []
    for await (const a of store.actors()) actors.push(a.ref)
    expect(actors.sort()).toEqual(["fake:author-a", "fake:author-c", "fake:author-d"])
    expect(report.coverage!.cells.reduce((n, c) => n + c.items, 0)).toBe(3)
  })

  it("uses the primary counter when a band names no metric, and can keep a missing metric", async () => {
    const store = memoryStore()
    const http = web({ p: [{ id: "a", views: 1 }, { id: "b" }] })
    const report = await createCollector({ store, transports: { http }, connectors: [sampled(["p"])] }).run(
      recipe({ bands: [{ min: 0, max: 10 }], keepMissingMetric: true }),
    )
    expect(await ids(store)).toEqual(["fake:a", "fake:b"])
    expect((await lines(store, report.runId)).map((l) => [l.candidate, l.decision, l.band])).toEqual([
      ["fake:a", "kept", 0],
      ["fake:b", "kept", undefined],
    ])
  })

  it("caps kept items per host, www stripped, using links.target for submissions", async () => {
    const store = memoryStore()
    const http = web({
      p: [
        { id: "a", url: "https://www.news.test/1" },
        { id: "b", url: "https://news.test/2" },
        { id: "c", url: "https://other.test/1" },
        // Its own url is the aggregator's; the article host is what counts.
        { id: "s1", kind: "submission", url: "https://agg.test/s1", target: "https://other.test/x" },
        { id: "s2", kind: "submission", url: "https://agg.test/s2", target: "https://www.third.test/x" },
      ],
    })
    const report = await createCollector({ store, transports: { http }, connectors: [sampled(["p"])] }).run(recipe({ perDomainCap: 1 }))
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

  it("does not sample tasks that read by URL", async () => {
    const store = memoryStore()
    const http = web({ list: [{ id: "a", views: 1 }, { id: "b", views: 2 }], one: [{ id: "c", views: 3 }, { id: "d", views: 4 }] })
    const report = await createCollector({ store, transports: { http }, connectors: [sampled(["list", "one"], { one: "read" })] }).run(
      recipe({ bands: [{ min: 0, max: 10, quota: 1 }] }),
    )
    expect(await ids(store)).toEqual(["fake:a", "fake:c", "fake:d"])
    expect(report.connectors[0]!.sampled).toMatchObject({ candidates: 2, kept: 1 })
  })

  describe("seed", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}`, views: 1 }))
    const pick = async (seed: number | undefined, order: Row[] = rows) => {
      const store = memoryStore()
      await createCollector({ store, transports: { http: web({ p: order }) }, connectors: [sampled(["p"])] }).run(
        recipe({ bands: [{ min: 0, max: 5, quota: 4 }], ...(seed === undefined ? {} : { seed }) }),
      )
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

    it("keeps the first seen in plan order without a seed", async () => {
      expect(await pick(undefined)).toEqual(["fake:r00", "fake:r01", "fake:r02", "fake:r03"])
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
      await createCollector({ store: whole, transports: { http: web(pages) }, connectors: [sampled(["t1", "t2", "t3"])] }).run(recipe(sampling))

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

    it("rebuilds counters from sampling.jsonl", () => {
      const cfg = { bands: [{ min: 0, max: 9, quota: 1 }], perDomainCap: 1 }
      const mk = (id: string) => ({ id, metrics: { views: 1 }, url: `https://${id}.test/` })
      const first = createSampler(cfg, "views", [])
      const kept = first.decide("k", [mk("a")]).map((d) => ({ ...d.decision, at: "2026-11-28T10:00:00Z" }))
      const second = createSampler(cfg, "views", kept)
      expect(second.decide("k", [mk("a")])[0]).toMatchObject({ fresh: false, decision: { decision: "kept" } })
      expect(second.decide("k", [mk("b")])[0]!.decision).toMatchObject({ decision: "dropped", rule: "band_quota" })
    })
  })

  it("mulberry32 is deterministic", () => {
    const a = mulberry32(5)
    const b = mulberry32(5)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})
