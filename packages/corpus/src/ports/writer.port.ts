/**
 * WriterPort — the corpus kit's path into a backing knowledge engine.
 *
 * The kit never imports IKnowledgeProvider — that's an agstudio type.
 * Instead it consumes this minimal port; the host (agstudio
 * CorpusInternalWriter in cloud, future local-CLI bridge) supplies
 * the implementation.
 *
 * Matches the shape of `CorpusInternalWriter` in
 * `packages/integration/knowledge/src/providers/corpus/internal-writer.ts`
 * so the cloud-topology adapter is a one-to-one satisfying type.
 */

export interface WriterChunk {
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface PushChunksInput {
  readonly entrySlug: string
  readonly entryPath: string
  readonly title?: string
  readonly uri?: string
  readonly chunks: readonly WriterChunk[]
  readonly entryMetadata?: Readonly<Record<string, unknown>>
  /**
   * The entry's full parsed frontmatter. Vector engines ignore it; a
   * graph-projection writer reads the relation arrays the flattened
   * `entryMetadata` drops (`links` / `supersedes` / `contradicts`) to build
   * entry↔entry edges. Optional — absence just means no graph projection.
   */
  readonly entryFrontmatter?: Readonly<Record<string, unknown>>
}

/**
 * A `knowledge.source/v1` doc to project. Sources never chunk into a vector
 * engine, so they have their own port method (not `pushChunks`). A graph
 * writer projects the full source frontmatter (title / authority /
 * content_hash / …) into a real Source node; a vector writer no-ops.
 */
export interface PushSourceInput {
  readonly sourceId: string
  readonly sourcePath: string
  readonly title?: string
  /** The source's full parsed frontmatter (`knowledge.source/v1`). */
  readonly sourceFrontmatter: Readonly<Record<string, unknown>>
}

export interface WriterPort {
  pushChunks(input: PushChunksInput): Promise<readonly string[]>
  removeEntry(entrySlug: string): Promise<{ removed: number }>
  /**
   * Project a source doc. Optional — vector-only writers omit it (sources
   * aren't searchable chunks); a graph-projection writer implements it so
   * Source nodes carry full frontmatter, not just the stub id the
   * entry→source `DERIVED_FROM` path leaves behind.
   */
  pushSource?(input: PushSourceInput): Promise<void>
}
