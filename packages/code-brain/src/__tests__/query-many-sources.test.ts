/**
 * `queryManySources` proven against a hand-rolled FAKE `ICodeBrainProvider`
 * — no live backend. It is the client-side workaround for gbrain's `query`
 * tool accepting exactly one `source_id` per call: this fans out one
 * `graphQuery` per source in parallel and merges the results.
 */

import { describe, it, expect } from "vitest"
import { queryManySources } from "../query-many-sources.js"
import type { GraphHit, GraphQuery, GraphResult } from "../types.js"

function makeFakeProvider(bySource: Record<string, readonly GraphHit[]>): {
  graphQuery: (query: GraphQuery) => Promise<GraphResult>
  calls: GraphQuery[]
} {
  const calls: GraphQuery[] = []
  return {
    calls,
    async graphQuery(query) {
      calls.push(query)
      const hits = bySource[query.scope ?? ""] ?? []
      return { hits }
    },
  }
}

describe("queryManySources", () => {
  it("issues one graphQuery per source, in parallel, with the question and limit forwarded", async () => {
    const provider = makeFakeProvider({ a: [], b: [], c: [] })
    await queryManySources(provider, ["a", "b", "c"], "where is retry?", 5)

    expect(provider.calls).toEqual([
      { question: "where is retry?", scope: "a", limit: 5 },
      { question: "where is retry?", scope: "b", limit: 5 },
      { question: "where is retry?", scope: "c", limit: 5 },
    ])
  })

  it("omits limit from the per-source call when not given", async () => {
    const provider = makeFakeProvider({ a: [] })
    await queryManySources(provider, ["a"], "q")
    expect(provider.calls).toEqual([{ question: "q", scope: "a" }])
  })

  it("returns no hits and makes no calls for an empty source list", async () => {
    const provider = makeFakeProvider({})
    const result = await queryManySources(provider, [], "q")
    expect(result.hits).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it("merges hits from all sources and ranks the merged list by score", async () => {
    const provider = makeFakeProvider({
      a: [{ title: "low", body: "…", file: "a.ts", span: { startLine: 1, endLine: 1 }, score: 0.2 }],
      b: [{ title: "high", body: "…", file: "b.ts", span: { startLine: 1, endLine: 1 }, score: 0.9 }],
    })
    const result = await queryManySources(provider, ["a", "b"], "q")
    expect(result.hits.map((h) => h.title)).toEqual(["high", "low"])
  })

  it("dedupes hits sharing file+span across sources, keeping the first occurrence", async () => {
    const shared: GraphHit = {
      title: "shared",
      body: "same location",
      file: "shared.ts",
      span: { startLine: 10, endLine: 20 },
      score: 0.5,
    }
    const provider = makeFakeProvider({
      a: [shared],
      b: [{ ...shared, score: 0.99 }],
    })
    const result = await queryManySources(provider, ["a", "b"], "q")
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.score).toBe(0.5)
  })

  it("falls back to title+body for dedupe when a hit carries no file/span", async () => {
    const hit: GraphHit = { title: "no location", body: "same text", score: 0.3 }
    const provider = makeFakeProvider({
      a: [hit],
      b: [hit],
      c: [{ title: "no location", body: "different text", score: 0.7 }],
    })
    const result = await queryManySources(provider, ["a", "b", "c"], "q")
    expect(result.hits).toHaveLength(2)
  })

  it("treats hits with no score as ranking lowest", async () => {
    const provider = makeFakeProvider({
      a: [{ title: "scored", body: "…", score: 0.1 }],
      b: [{ title: "unscored", body: "…" }],
    })
    const result = await queryManySources(provider, ["a", "b"], "q")
    expect(result.hits.map((h) => h.title)).toEqual(["scored", "unscored"])
  })
})
