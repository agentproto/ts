/**
 * Corpus engine adapter: end-to-end query through CorpusAdapterCore over the
 * marketing fixture workspace + stub backing engine.
 *
 * Proves the central claim: a KB pointing at engineId="corpus" returns hits
 * with full AIP-10 provenance to the LLM, using any backing engine.
 *
 * Ported from the studio corpus provider's `__tests__/m4.test.ts`. The
 * guild-side `buildCorpusEngineDescriptor` block (which drove the studio
 * `createEngineRegistry`) is replaced by a `createStandaloneCorpusAdapter`
 * test — that descriptor stays studio-side (this package registers as a
 * provider-kit family instead, tested in `handle.test.ts`).
 */

import { describe, expect, it } from "vitest"
import { CorpusAdapterCore } from "../adapter.js"
import { CorpusInternalWriter } from "../internal-writer.js"
import { createStandaloneCorpusAdapter } from "../standalone.js"
import { createEmptyBacking } from "../empty-backing.js"
import type { KnowledgeHit } from "@agentproto/knowledge-engine"
import { loadM0FixtureFs, makeStubProvider, MemoryFs } from "./_helpers.js"

// ── Query + hydration ────────────────────────────────────────────────

describe("CorpusAdapterCore.query", () => {
  it("hydrates a backing-engine hit with full AIP-10 provenance", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: (): KnowledgeHit[] => [
        {
          sourceId: "stub-1",
          chunkId: "stub-1-0",
          text: "Open with a popularly-held belief, then contradict it.",
          score: 0.91,
          metadata: {
            corpus: {
              entrySlug: "contrarian-short-form-hooks",
              chunkIndex: 0,
            },
          },
        },
      ],
    })

    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      // Pin clock to right after the latest mention in the fixture
      // so temporalScore is reproducible.
      nowMs: () => Date.parse("2026-05-22T14:30:00Z"),
    })

    const result = await adapter.query({ query: "contrarian hook" })
    expect(result.engine).toBe("corpus")
    expect(result.hits.length).toBe(1)
    const hit = result.hits[0]!

    // Provenance from the AIP-10 entry file
    const meta = hit.metadata as Record<string, unknown>
    expect(meta.entryPath).toBe(
      "entries/patterns/2026/contrarian-short-form-hooks.md"
    )
    expect(meta.entrySlug).toBe("contrarian-short-form-hooks")
    expect(meta.kind).toBe("pattern")
    expect(meta.title).toBe("Contrarian short-form hooks")
    expect(Array.isArray(meta.sourceIds)).toBe(true)
    expect((meta.sourceIds as unknown[]).includes("tiktok-hook-2026-05")).toBe(
      true
    )
    expect(Array.isArray(meta.sourceHashes)).toBe(true)
    expect((meta.sourceHashes as string[])[0]).toMatch(/^sha256:/)

    // Corpus-namespaced provenance from metadata.corpus.*
    expect(meta.status).toBe("active")
    expect(meta.qualityScore).toBe(4.5)
    expect(meta.riskScore).toBe(1.0)
    expect(meta.domain).toBe("marketing")
    expect(meta.channel).toBe("tiktok")

    // Temporal block computed live
    const temporal = meta.temporal as {
      lastSeen: string
      mentionCount: number
      temporalScore: number
    }
    expect(temporal.mentionCount).toBe(2)
    expect(temporal.lastSeen).toBe("2026-05-22T14:30:00Z")
    // The most-recent mention is exactly now; temporalScore ≈ 1
    expect(temporal.temporalScore).toBeGreaterThan(0.99)
  })

  it("passes through hits the backing engine returns without entrySlug (non-corpus)", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: (): KnowledgeHit[] => [
        {
          sourceId: "stub-9",
          chunkId: "stub-9-0",
          text: "Some uncorpus chunk",
          score: 0.4,
          metadata: { title: "Random thing" },
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
    })
    const result = await adapter.query({ query: "random" })
    expect(result.hits[0]?.metadata).toEqual({ title: "Random thing" })
  })

  it("forwards `q.filter` opaquely to the backing engine", async () => {
    const fs = loadM0FixtureFs()
    let seenFilter: unknown = undefined
    const { provider: backing } = makeStubProvider({
      hitsForQuery: q => {
        seenFilter = q.filter
        return []
      },
    })
    const adapter = new CorpusAdapterCore({ fs, workspacePath: "", backing })
    await adapter.query({
      query: "x",
      filter: { status: "active", minQualityScore: 4.0 },
    })
    expect(seenFilter).toEqual({ status: "active", minQualityScore: 4.0 })
  })

  it("temporal score decays for an old mention with a short half-life", async () => {
    // Sidestep the marketing fixture and build a tiny one with custom half-life
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: tiny",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "---",
      ].join("\n"),
      "entries/foo.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: foo",
        "kind: principle",
        "title: F",
        'updated_at: "2025-01-01T00:00:00Z"',
        "metadata:",
        "  corpus:",
        "    status: active",
        "    temporal:",
        "      halfLifeDays: 30",
        "      mentions:",
        '        - { at: "2025-01-01T00:00:00Z", weight: 1.0 }',
        "---",
      ].join("\n"),
    })
    const { provider: backing } = makeStubProvider({
      hitsForQuery: (): KnowledgeHit[] => [
        {
          sourceId: "stub-1",
          chunkId: "c",
          text: "x",
          score: 0.5,
          metadata: { corpus: { entrySlug: "foo" } },
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      // 90 days after the mention → temporalScore = exp(-ln2 * 90/30) = 0.125
      nowMs: () => Date.parse("2025-04-01T00:00:00Z"),
    })
    const result = await adapter.query({ query: "x" })
    const t = (
      result.hits[0]?.metadata as { temporal?: { temporalScore?: number } }
    ).temporal
    expect(t?.temporalScore).toBeCloseTo(0.125, 2)
  })
})

// ── Listing + read ───────────────────────────────────────────────────

describe("CorpusAdapterCore.listSources / getSource", () => {
  it("listSources reads canonical AIP-10 sources/ (not backing engine)", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider()
    const adapter = new CorpusAdapterCore({ fs, workspacePath: "", backing })
    const sources = await adapter.listSources()
    expect(sources.length).toBe(1)
    expect(sources[0]?.id).toBe("tiktok-hook-2026-05")
    expect(sources[0]?.uri).toBe("sources/fresh/tiktok-hook-2026-05.md")
    expect(
      (sources[0]?.metadata as { contentHash?: string }).contentHash
    ).toMatch(/^sha256:/)
  })

  it("getSource returns the canonical AIP-10 source by id, null if missing", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider()
    const adapter = new CorpusAdapterCore({ fs, workspacePath: "", backing })
    const s = await adapter.getSource("tiktok-hook-2026-05")
    expect(s).not.toBeNull()
    expect(s?.title).toBe("TikTok contrarian hook example — May 2026")
    expect(await adapter.getSource("nonexistent")).toBeNull()
  })
})

// ── Public write rejection ───────────────────────────────────────────

describe("CorpusAdapterCore — public ingest/deleteSource ALWAYS reject", () => {
  it("ingest() always throws — no path to bypass the lifecycle", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider()
    const adapter = new CorpusAdapterCore({ fs, workspacePath: "", backing })
    await expect(
      adapter.ingest({ kind: "text", uri: "/tmp/x", content: "hi" })
    ).rejects.toThrow(/not permitted/)
  })

  it("deleteSource() always throws", async () => {
    const fs = loadM0FixtureFs()
    const { provider: backing } = makeStubProvider()
    const adapter = new CorpusAdapterCore({ fs, workspacePath: "", backing })
    await expect(adapter.deleteSource("anything")).rejects.toThrow(
      /not permitted/
    )
  })
})

// ── Internal writer (privileged path) ────────────────────────────────

describe("CorpusInternalWriter", () => {
  it("pushChunks ingests each chunk into the backing engine with corpus metadata", async () => {
    const { provider: backing, state } = makeStubProvider()
    const writer = new CorpusInternalWriter({ backing })
    const ids = await writer.pushChunks({
      entrySlug: "foo",
      entryPath: "entries/principles/2026/foo.md",
      title: "Foo",
      chunks: [
        { text: "chunk one" },
        { text: "chunk two", metadata: { corpus: { extraTag: "y" } } },
      ],
      entryMetadata: { status: "active", qualityScore: 4.5 },
    })
    expect(ids.length).toBe(2)
    expect(state.ingestedInputs.length).toBe(2)
    const first = state.ingestedInputs[0]!.metadata as {
      corpus: {
        entrySlug: string
        chunkIndex: number
        status: string
        qualityScore: number
      }
    }
    expect(first.corpus.entrySlug).toBe("foo")
    expect(first.corpus.chunkIndex).toBe(0)
    expect(first.corpus.status).toBe("active")
    expect(first.corpus.qualityScore).toBe(4.5)
    const second = state.ingestedInputs[1]!.metadata as {
      corpus: { extraTag?: string }
    }
    expect(second.corpus.extraTag).toBe("y")
  })

  it("removeEntry deletes every backing source matching the entrySlug", async () => {
    const { provider: backing, state } = makeStubProvider()
    const writer = new CorpusInternalWriter({ backing })
    await writer.pushChunks({
      entrySlug: "foo",
      entryPath: "entries/principles/2026/foo.md",
      chunks: [{ text: "a" }, { text: "b" }],
    })
    await writer.pushChunks({
      entrySlug: "bar",
      entryPath: "entries/principles/2026/bar.md",
      chunks: [{ text: "c" }],
    })
    const out = await writer.removeEntry("foo")
    expect(out.removed).toBe(2)
    expect(state.deletedIds).toEqual(["stub-1", "stub-2"])
  })

  it("round-trips chunks through the standalone empty backing", async () => {
    // The empty backing keeps its own in-memory source list, so the
    // privileged writer's pushChunks → listSources → removeEntry cycle
    // works standalone (only `query()` yields no hits).
    const backing = createEmptyBacking()
    const writer = new CorpusInternalWriter({ backing })
    await writer.pushChunks({
      entrySlug: "foo",
      entryPath: "entries/foo.md",
      chunks: [{ text: "a" }, { text: "b" }],
    })
    expect((await backing.listSources()).length).toBe(2)
    const out = await writer.removeEntry("foo")
    expect(out.removed).toBe(2)
    expect((await backing.listSources()).length).toBe(0)
  })
})

// ── Standalone factory (replaces the guild-side descriptor wiring) ────

describe("createStandaloneCorpusAdapter", () => {
  it("reports id 'corpus' and forces citations capability on the empty backing", () => {
    const adapter = createStandaloneCorpusAdapter({ root: process.cwd() })
    expect(adapter.id).toBe("corpus")
    // capabilities derive from the (empty) backing + force citations: true
    expect(adapter.capabilities.citations).toBe(true)
  })

  it("exposes the wrapped backing via the structural unwrap capability", () => {
    const { provider: backing } = makeStubProvider({ id: "stub-backing" })
    const adapter = createStandaloneCorpusAdapter({
      backing,
      root: process.cwd(),
    })
    expect(adapter.unwrapCorpusBacking()).toBe(backing)
    expect(adapter.corpusWorkspacePath).toBe("")
  })
})
