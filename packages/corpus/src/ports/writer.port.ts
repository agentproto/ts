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
}

export interface WriterPort {
  pushChunks(input: PushChunksInput): Promise<readonly string[]>
  removeEntry(entrySlug: string): Promise<{ removed: number }>
}
