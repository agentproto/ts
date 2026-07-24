/**
 * An in-memory FAKE `IKnowledgeProvider` — the retrieval sibling of the
 * hand-rolled fake code-brain provider used in code-brain's tests
 * (`packages/code-brain/src/__tests__/ask-codebase.test.ts`). It is the whole
 * point of the pure contract package: `kb_query` / `kb_ingest` are exercised
 * end-to-end, round-tripping real ingest→query, before any real backend
 * (vector store, graph db, BM25) exists.
 *
 * The fake stores sources in a Map and answers queries with a naive
 * case-insensitive substring scan over each source's title + inline content.
 * It supports ONE real retrieval mode (`vector`), so it also proves the
 * contract's "mode is a hint" rule: an unsupported requested mode falls back
 * and is echoed truthfully in `modeUsed`, and the `"none"` cold-start
 * sentinel returns zero hits.
 *
 * This module is dependency-free beyond the pure contract — it names no
 * engine and imports nothing outside this package.
 */

import type { IKnowledgeProvider } from "../provider.js"
import type {
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "../types.js"

/** A stored source plus the flattened text the fake scans on query. */
interface StoredSource {
  readonly source: KnowledgeSource
  readonly haystack: string
}

const FAKE_CAPABILITIES: KnowledgeCapabilities = {
  vectorSearch: true,
  graphTraversal: false,
  hybridSearch: false,
  multiModal: false,
  streaming: false,
  citations: true,
  maxChunkBytes: 1 << 20,
}

function decodeContent(content: Uint8Array | string | undefined): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return new TextDecoder().decode(content)
}

function byteLength(content: Uint8Array | string | undefined): number {
  if (content === undefined) return 0
  if (typeof content === "string") return new TextEncoder().encode(content).length
  return content.byteLength
}

/**
 * Options to seed deterministic behaviour in tests. `now` fixes the
 * `indexedAt` timestamp and the `tookMs` value so assertions are stable
 * without reaching for the wall clock.
 */
export interface FakeKnowledgeProviderOptions {
  readonly id?: string
  readonly indexedAt?: Date
}

/**
 * Construct an in-memory fake. Exposed as a factory (not a class instance)
 * so tests can spin up a fresh, isolated KB per case.
 */
export function createFakeKnowledgeProvider(
  options: FakeKnowledgeProviderOptions = {},
): IKnowledgeProvider {
  const id = options.id ?? "fake-knowledge"
  const indexedAt = options.indexedAt ?? new Date(0)
  const store = new Map<string, StoredSource>()
  let seq = 0

  return {
    id,
    capabilities: FAKE_CAPABILITIES,

    async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
      seq += 1
      const sourceId = `src-${seq}`
      const text = decodeContent(input.content)
      const source: KnowledgeSource = {
        id: sourceId,
        kind: input.kind,
        uri: input.uri,
        ...(input.title !== undefined ? { title: input.title } : {}),
        metadata: input.metadata ?? {},
        bytes: byteLength(input.content),
        status: "ready",
        indexedAt,
      }
      const title = input.title ?? ""
      store.set(sourceId, {
        source,
        haystack: `${title}\n${text}`.toLowerCase(),
      })
      return source
    },

    async query(q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
      // "none" is the cold-start sentinel — echo it, return no hits.
      if (q.mode === "none") {
        return { hits: [], tookMs: 0, engine: id, modeUsed: "none" }
      }
      // The fake only really does vector search; any other requested mode
      // (graph/hybrid) falls back to it — and `modeUsed` tells the truth.
      const needle = q.query.toLowerCase()
      const minScore = q.minScore ?? 0
      const matches: KnowledgeHit[] = []
      for (const { source, haystack } of store.values()) {
        const at = haystack.indexOf(needle)
        if (at < 0) continue
        // Naive score: more occurrences ⇒ higher score, capped at 1.
        let count = 0
        let from = at
        while (from >= 0) {
          count += 1
          from = haystack.indexOf(needle, from + Math.max(needle.length, 1))
        }
        const score = Math.min(1, count / 3)
        if (score < minScore) continue
        matches.push({
          sourceId: source.id,
          chunkId: `${source.id}-0`,
          text: source.title ?? source.uri,
          score,
          span: { start: at, end: at + needle.length },
          metadata: source.metadata,
        })
      }
      matches.sort((a, b) => b.score - a.score)
      const topK = q.topK ?? matches.length
      return {
        hits: matches.slice(0, topK),
        tookMs: 0,
        engine: id,
        modeUsed: "vector",
      }
    },

    async listSources(filter?: ListSourcesFilter): Promise<readonly KnowledgeSource[]> {
      const all = [...store.values()].map((s) => s.source)
      return all.filter((s) => {
        if (filter?.kind !== undefined && s.kind !== filter.kind) return false
        if (filter?.status !== undefined && s.status !== filter.status) return false
        return true
      })
    },

    async getSource(sourceId: string): Promise<KnowledgeSource | null> {
      return store.get(sourceId)?.source ?? null
    },

    async deleteSource(sourceId: string): Promise<void> {
      store.delete(sourceId)
    },

    async healthCheck(): Promise<boolean> {
      return true
    },

    async dispose(): Promise<void> {
      store.clear()
    },
  }
}
