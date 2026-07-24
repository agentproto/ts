/**
 * A minimal, in-process `IKnowledgeProvider` that holds no vectors and
 * returns no query hits.
 *
 * The corpus adapter is a COMPOSITION wrapper — it hydrates + access-filters
 * whatever a backing engine returns, it is not itself a vector store. To run
 * `CorpusAdapterCore` standalone (health probe, or the `sources/…`-only read
 * paths that never touch the backing) a backing must still be supplied. This
 * is that no-op backing: `query()` yields zero hits, writes round-trip a
 * synthetic in-memory source list so `CorpusInternalWriter` still functions,
 * and `healthCheck()` is always true.
 *
 * Real retrieval standalone-side needs a real backing engine (the files
 * adapter, or an external vector store) injected via
 * {@link createStandaloneCorpusAdapter}'s `backing`
 * option — this default only powers the workspace-direct surface
 * (`listSources` / `getSource` / provenance hydration of injected hits) and
 * the health probe.
 */

import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "@agentproto/knowledge-engine"

export const EMPTY_BACKING_ID = "corpus-empty-backing" as const

const EMPTY_BACKING_CAPABILITIES: KnowledgeCapabilities = Object.freeze({
  vectorSearch: false,
  graphTraversal: false,
  hybridSearch: false,
  multiModal: false,
  streaming: false,
  citations: true,
  maxChunkBytes: 64 * 1024,
})

/**
 * Build a fresh no-op backing. Each instance keeps its own in-memory source
 * list so `CorpusInternalWriter.pushChunks`/`removeEntry` behave (the writer
 * ingests into and lists back from THIS backing), while `query()` never
 * surfaces hits — there is no index.
 */
export function createEmptyBacking(): IKnowledgeProvider {
  const sources = new Map<string, KnowledgeSource>()
  let counter = 0

  return {
    id: EMPTY_BACKING_ID,
    capabilities: EMPTY_BACKING_CAPABILITIES,
    async ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource> {
      counter += 1
      const bytes =
        typeof input.content === "string"
          ? new TextEncoder().encode(input.content).byteLength
          : (input.content?.byteLength ?? 0)
      const source: KnowledgeSource = {
        id: `${EMPTY_BACKING_ID}-${counter}`,
        kind: input.kind,
        uri: input.uri,
        title: input.title,
        bytes,
        status: "ready",
        indexedAt: new Date(0),
        metadata: input.metadata ?? {},
      }
      sources.set(source.id, source)
      return source
    },
    async query(_q: KnowledgeQuery): Promise<KnowledgeQueryResult> {
      return {
        engine: EMPTY_BACKING_ID,
        modeUsed: "vector",
        hits: Object.freeze([]),
        tookMs: 0,
      }
    },
    async listSources(
      filter?: ListSourcesFilter
    ): Promise<readonly KnowledgeSource[]> {
      const out: KnowledgeSource[] = []
      for (const source of sources.values()) {
        if (filter?.kind && source.kind !== filter.kind) continue
        if (filter?.status && source.status !== filter.status) continue
        out.push(source)
      }
      return Object.freeze(out)
    },
    async getSource(id: string): Promise<KnowledgeSource | null> {
      return sources.get(id) ?? null
    },
    async deleteSource(id: string): Promise<void> {
      sources.delete(id)
    },
    async healthCheck(): Promise<boolean> {
      return true
    },
    async dispose(): Promise<void> {
      sources.clear()
    },
  }
}
