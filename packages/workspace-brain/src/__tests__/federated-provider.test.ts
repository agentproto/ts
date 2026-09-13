/**
 * Tests for {@link FederatedKnowledgeProvider} — fan-out query + merge,
 * auto-only ingest fan-out, and graceful degradation / unioning of the
 * read + admin verbs across all sub-providers.
 *
 * Uses a small inline stub implementing `IKnowledgeProvider` with
 * controllable fixed scores (no real adapter, no I/O), so every assertion is
 * deterministic.
 */

import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  KnowledgeQueryMode,
} from "@agentproto/knowledge-engine"
import { describe, expect, it } from "vitest"
import { FederatedKnowledgeProvider } from "../federated-provider.js"
import type { ResolvedProvider } from "../provider-resolver.js"

interface StubOptions {
  scores?: number[]
  health?: boolean
  failQuery?: boolean
  failIngest?: boolean
  deleteThrows?: boolean
  modeUsed?: KnowledgeQueryMode
  engine?: string
  weight?: number
  auto?: boolean
  vectorSearch?: boolean
  maxChunkBytes?: number
}

interface StubState {
  readonly id: string
  readonly weight: number
  readonly auto: boolean
  readonly health: boolean
  readonly ingested: KnowledgeIngestInput[]
  readonly deleted: string[]
  disposed: number
}

function makeStub(id: string, opts: StubOptions = {}) {
  const state: StubState = {
    id,
    weight: opts.weight ?? 1,
    auto: opts.auto ?? true,
    health: opts.health ?? true,
    ingested: [],
    deleted: [],
    disposed: 0,
  }
  const hits: KnowledgeHit[] = (opts.scores ?? []).map((score, i) => ({
    sourceId: `${id}-src`,
    chunkId: `${id}-chunk-${i}`,
    text: `hit ${id} ${i}`,
    score,
    metadata: {},
  }))
  const capabilities: KnowledgeCapabilities = {
    vectorSearch: opts.vectorSearch ?? false,
    graphTraversal: false,
    hybridSearch: false,
    multiModal: false,
    streaming: false,
    citations: true,
    maxChunkBytes: opts.maxChunkBytes ?? 1024,
  }
  const provider: IKnowledgeProvider = {
    id,
    capabilities,
    async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
      if (opts.failIngest) throw new Error(`${id} ingest failed`)
      state.ingested.push(input)
      return {
        id: `${id}-ingested`,
        kind: input.kind,
        uri: input.uri,
        metadata: input.metadata ?? {},
        bytes: 0,
        status: "ready",
        indexedAt: new Date(),
      }
    },
    async query(_q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
      if (opts.failQuery) throw new Error(`${id} query failed`)
      return {
        hits,
        tookMs: 1,
        engine: opts.engine ?? id,
        modeUsed: opts.modeUsed ?? "vector",
      }
    },
    async listSources() {
      return []
    },
    async getSource() {
      return null
    },
    async deleteSource(sourceId: string) {
      if (opts.deleteThrows) throw new Error(`${id} delete failed`)
      state.deleted.push(sourceId)
    },
    async healthCheck() {
      return state.health
    },
    async dispose() {
      state.disposed += 1
    },
  }
  const resolved: ResolvedProvider = {
    id,
    weight: state.weight,
    auto: state.auto,
    provider,
  }
  return { resolved, state, hits }
}

describe("FederatedKnowledgeProvider.query", () => {
  it("merges hits from multiple providers by min-max normalized × weight", async () => {
    const a = makeStub("a", { scores: [1.0, 0.0] })
    const b = makeStub("b", { scores: [0.5] })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    // A#1 (norm 1.0), B#1 (max==min → 1.0), A#2 (norm 0.0) — descending by
    // merged score, ties keep provider insertion order.
    expect(r.hits.map(h => h.chunkId)).toEqual([
      "a-chunk-0",
      "b-chunk-0",
      "a-chunk-1",
    ])
    expect(r.engine).toBe("federated")
    expect(r.tookMs).toBe(2)
  })

  it("slices the merged result to topK", async () => {
    const a = makeStub("a", { scores: [1.0, 0.0] })
    const b = makeStub("b", { scores: [0.5] })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 2 })
    expect(r.hits.map(h => h.chunkId)).toEqual(["a-chunk-0", "b-chunk-0"])
  })

  it("applies per-provider weights to the normalized score", async () => {
    const a = makeStub("a", { scores: [0.5] })
    const b = makeStub("b", { scores: [0.5], weight: 2 })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    // a: 1.0 (degenerate min-max) × 1, b: 1.0 × 2 → b outranks a despite
    // identical raw scores.
    expect(r.hits.map(h => h.chunkId)).toEqual(["b-chunk-0", "a-chunk-0"])
  })

  it("passes a single provider's result through UNCHANGED", async () => {
    const files = makeStub("files", {
      scores: [0.85, 0.33],
      engine: "files",
      modeUsed: "hybrid",
    })
    const fed = new FederatedKnowledgeProvider({ providers: [files.resolved] })

    const r = await fed.query({ query: "cargo", topK: 5 })
    // Not re-wrapped: raw scores, the provider's own engine, its own modeUsed.
    expect(r.engine).toBe("files")
    expect(r.modeUsed).toBe("hybrid")
    expect(r.hits.map(h => h.score)).toEqual([0.85, 0.33])
  })

  it("degrades gracefully when a provider throws (never throws)", async () => {
    const a = makeStub("a", { scores: [0.5], failQuery: true })
    const b = makeStub("b", { scores: [0.7] })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    expect(r.hits.map(h => h.chunkId)).toEqual(["b-chunk-0"])
    expect(r.engine).toBe("federated")
  })

  it("returns empty (never throws) when EVERY provider fails", async () => {
    const a = makeStub("a", { scores: [0.5], failQuery: true })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved] })
    const r = await fed.query({ query: "x", topK: 10 })
    expect(r.hits).toEqual([])
    expect(r.engine).toBe("federated")
    expect(r.modeUsed).toBe("none")
  })

  it("consults only defaultQueryProviders (intersected with real provider ids)", async () => {
    const a = makeStub("a", { scores: [1.0] })
    const b = makeStub("b", { scores: [0.9] })
    const fed = new FederatedKnowledgeProvider({
      providers: [a.resolved, b.resolved],
      defaultQueryProviders: ["a"],
    })

    const r = await fed.query({ query: "x", topK: 10 })
    // Single consulted provider → passthrough, b never queried.
    expect(r.engine).toBe("a")
    expect(r.hits.map(h => h.chunkId)).toEqual(["a-chunk-0"])
  })

  it("queries all providers when defaultQueryProviders is absent", async () => {
    const a = makeStub("a", { scores: [1.0] })
    const b = makeStub("b", { scores: [0.9] })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    expect(r.hits.map(h => h.chunkId)).toEqual(["a-chunk-0", "b-chunk-0"])
  })

  it("returns an empty federated result when no hits come back", async () => {
    const a = makeStub("a", { scores: [] })
    const b = makeStub("b", { scores: [] })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    expect(r.hits).toEqual([])
    expect(r.engine).toBe("federated")
    expect(r.modeUsed).toBe("none")
  })

  it("reports the modeUsed of the result that contributed the top hit", async () => {
    const a = makeStub("a", { scores: [1.0], modeUsed: "hybrid" })
    const b = makeStub("b", { scores: [0.4], modeUsed: "vector" })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.query({ query: "x", topK: 10 })
    expect(r.hits).toHaveLength(2)
    expect(r.modeUsed).toBe("hybrid")
  })
})

describe("FederatedKnowledgeProvider.ingest", () => {
  it("fans out to auto providers only and returns the first success", async () => {
    const a = makeStub("a", { auto: true })
    const b = makeStub("b", { auto: false })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const input: KnowledgeIngestInput = { kind: "text", uri: "sess-1", content: "hi" }
    const r = await fed.ingest(input)
    expect(r.id).toBe("a-ingested")
    expect(a.state.ingested).toHaveLength(1)
    expect(b.state.ingested).toHaveLength(0)
  })

  it("returns the first fulfilled result even when another auto provider fails", async () => {
    const a = makeStub("a", { auto: true, failIngest: true })
    const b = makeStub("b", { auto: true })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    const r = await fed.ingest({ kind: "text", uri: "sess-2", content: "hi" })
    expect(r.id).toBe("b-ingested")
  })

  it("throws the first rejection when every auto provider fails", async () => {
    const a = makeStub("a", { auto: true, failIngest: true })
    const b = makeStub("b", { auto: true, failIngest: true })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })

    await expect(fed.ingest({ kind: "text", uri: "sess-3", content: "hi" })).rejects.toThrow(
      /a ingest failed/,
    )
  })

  it("throws a clear error when there are no auto providers", async () => {
    const a = makeStub("a", { auto: false })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved] })

    await expect(fed.ingest({ kind: "text", uri: "sess-4", content: "hi" })).rejects.toThrow(
      /no auto providers/,
    )
  })
})

describe("FederatedKnowledgeProvider admin + lifecycle verbs", () => {
  it("healthCheck: true when ANY provider is healthy", async () => {
    const a = makeStub("a", { health: false })
    const b = makeStub("b", { health: true })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })
    expect(await fed.healthCheck()).toBe(true)
  })

  it("healthCheck: false when none are healthy (or all throw)", async () => {
    const a = makeStub("a", { health: false })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved] })
    expect(await fed.healthCheck()).toBe(false)
  })

  it("deleteSource: resolves when at least one provider deletes", async () => {
    const a = makeStub("a", { deleteThrows: true })
    const b = makeStub("b")
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })
    await expect(fed.deleteSource("src-1")).resolves.toBeUndefined()
    expect(b.state.deleted).toEqual(["src-1"])
  })

  it("deleteSource: throws when every provider rejects", async () => {
    const a = makeStub("a", { deleteThrows: true })
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved] })
    await expect(fed.deleteSource("src-1")).rejects.toThrow(/a delete failed/)
  })

  it("dispose: fans out to all providers", async () => {
    const a = makeStub("a")
    const b = makeStub("b")
    const fed = new FederatedKnowledgeProvider({ providers: [a.resolved, b.resolved] })
    await fed.dispose()
    expect(a.state.disposed).toBe(1)
    expect(b.state.disposed).toBe(1)
  })

  it("merges capabilities: boolean caps OR'd, maxChunkBytes = min", async () => {
    const vector = makeStub("vector", { vectorSearch: true, maxChunkBytes: 2048 })
    const keyword = makeStub("keyword", { vectorSearch: false, maxChunkBytes: 64 * 1024 })
    const fed = new FederatedKnowledgeProvider({
      providers: [vector.resolved, keyword.resolved],
    })
    expect(fed.capabilities.vectorSearch).toBe(true)
    expect(fed.capabilities.maxChunkBytes).toBe(2048)

    const onlyKeyword = makeStub("kw", { vectorSearch: false })
    const fed2 = new FederatedKnowledgeProvider({ providers: [onlyKeyword.resolved] })
    expect(fed2.capabilities.vectorSearch).toBe(false)
    expect(fed2.capabilities.hybridSearch).toBe(false)
  })
})
