/**
 * CorpusInternalWriter — privileged write path for the corpus engine.
 *
 * Architectural invariant: the corpus engine is the ONLY
 * `IKnowledgeProvider` whose `ingest()` is publicly rejected. Writes
 * happen through `CorpusInternalWriter`, which:
 *   - is NOT an IKnowledgeProvider (deliberately not interchangeable),
 *   - is NOT registered in any registry callable by tools,
 *   - is constructed only by the host (`corpus-host.ts`) at boot,
 *   - is held only by `CorpusIndexer`.
 *
 * Tools that try to write via `corpus.bundle.ts` go through the
 * lifecycle workflows (create_candidate → analyze → promote). The
 * indexer is the eventual writer at the end of `promote`.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/corpus/internal-writer.ts`) —
 * the only change is the two import paths: the `IKnowledgeProvider` contract +
 * data types now come from `@agentproto/knowledge-engine` (was
 * `../base-knowledge.provider` / `../../types/knowledge.types`).
 */

import type {
  IKnowledgeProvider,
  KnowledgeIngestInput,
  KnowledgeSource,
} from "@agentproto/knowledge-engine"
import { readCorpusBlock } from "./frontmatter.js"

export interface CorpusInternalWriterOptions {
  /**
   * The same backing engine the CorpusAdapterCore wraps. The writer
   * pushes chunks to the backing engine's `ingest()` path — that's how
   * vectors land in the vector store. Round-tripping back through the
   * adapter would loop indefinitely (public ingest is rejected); the
   * writer goes around the public surface.
   */
  readonly backing: IKnowledgeProvider
}

/**
 * Chunked entry payload the indexer hands to the writer. Indexer is
 * responsible for chunking; writer is responsible for shipping bytes
 * to the backing engine with the corpus-namespaced metadata so the
 * adapter's hydration can find its way back.
 */
export interface CorpusEntryChunk {
  /** Chunk text — already split + sized to fit the backing engine. */
  readonly text: string
  /** Optional per-chunk metadata beyond the entry-level provenance. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface PushChunksInput {
  /** Stable entry slug — the adapter hydrates hits via `metadata.corpus.entrySlug`. */
  readonly entrySlug: string
  /** AIP-10 canonical path for the entry, e.g. "entries/principles/2026/foo.md". */
  readonly entryPath: string
  /** Optional title for the source registered in the backing engine. */
  readonly title?: string
  /** Optional URI/canonical reference, falls back to the entry path. */
  readonly uri?: string
  /** All chunks for this entry, pre-split. */
  readonly chunks: readonly CorpusEntryChunk[]
  /**
   * Additional corpus-level metadata to attach to every chunk —
   * propagated to backing-engine payload so the adapter's hydration
   * + filter translation can read these without re-loading the file.
   * The indexer typically passes `{ status, qualityScore, riskScore,
   * domain, channel, kind, ... }`.
   */
  readonly entryMetadata?: Readonly<Record<string, unknown>>
}

export class CorpusInternalWriter {
  constructor(private readonly opts: CorpusInternalWriterOptions) {}

  /**
   * Push chunks for one entry into the backing engine. Each chunk
   * becomes one source on the backing engine, namespaced under
   * `metadata.corpus.entrySlug` so the adapter's hydration can find
   * it.
   *
   * Returns the backing-engine source ids in order so the indexer can
   * record them in the entry's `metadata.corpus.backingSourceIds` (or
   * similar) for the drift detector.
   */
  async pushChunks(input: PushChunksInput): Promise<readonly string[]> {
    const sourceIds: string[] = []
    for (let i = 0; i < input.chunks.length; i++) {
      const chunk = input.chunks[i]!
      const ingest: KnowledgeIngestInput = {
        kind: "text",
        uri: input.uri ?? input.entryPath,
        title: input.title,
        content: chunk.text,
        metadata: {
          // Tag every chunk so the adapter's hydration can find the
          // entry. Both the chunk-specific metadata and the
          // entry-level metadata land under `metadata.corpus.*`.
          corpus: {
            entrySlug: input.entrySlug,
            entryPath: input.entryPath,
            chunkIndex: i,
            ...(input.entryMetadata ?? {}),
            ...((chunk.metadata?.corpus as
              | Record<string, unknown>
              | undefined) ?? {}),
          },
          // Forward any non-corpus chunk metadata at the top level so
          // engines that filter on adapter-side keys see it.
          ...(stripCorpus(chunk.metadata) ?? {}),
        },
      }
      const source = await this.opts.backing.ingest(ingest)
      sourceIds.push(source.id)
    }
    return Object.freeze(sourceIds)
  }

  /**
   * Remove every chunk associated with an entry from the backing
   * engine. Used on entry deprecation / supersession / GDPR erasure.
   *
   * Default implementation: walk the backing engine's source list and
   * delete each one whose metadata.corpus.entrySlug matches. For
   * engines that don't carry chunk metadata back through listSources,
   * the indexer falls back to the entry's stored `backingSourceIds`
   * list.
   */
  async removeEntry(entrySlug: string): Promise<{
    readonly removed: number
  }> {
    const sources = await this.opts.backing.listSources()
    let removed = 0
    for (const s of sources) {
      const tag = readCorpusBlock(s.metadata).entrySlug
      if (tag === entrySlug) {
        await this.opts.backing.deleteSource(s.id)
        removed++
      }
    }
    return { removed }
  }
}

function stripCorpus(
  meta: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const { corpus: _drop, ...rest } = meta as { corpus?: unknown } & Record<
    string,
    unknown
  >
  return rest
}
