/**
 * The ingest pipeline — turn a workspace's session transcripts into queryable
 * knowledge sources.
 *
 * For each session not yet ingested (or forced), the pipeline:
 *   1. resolves its exported transcript through the injected `readSession`,
 *   2. flattens it to turns through a {@link BrainSessionSourcePort} (which
 *      also strips the leading harness/system preamble — see that file),
 *   3. splits those turns into byte-bounded chunks (`chunking.ts`) — never
 *      mid-turn — and renders each chunk as its own markdown document,
 *   4. routes each chunk through `provider.ingest()`, which writes
 *      `<brain>/knowledge/sources/<chunk-id>.md` AND invalidates the engine's
 *      BM25 cache (so a subsequent query sees it immediately),
 *   5. records every chunk's source id against the session in
 *      `brain-state.json`.
 *
 * Chunking exists because one 800-turn session as a single BM25 doc ranks
 * poorly (length dilutes term frequency) and its snippet is always near the
 * START of the doc — usually not the relevant passage. Splitting on turn
 * boundaries into right-sized chunks makes each chunk independently
 * rankable, with a snippet that actually lands near the match. Chunk 0
 * always uses the bare session id as its uri, so a session that fits in one
 * chunk (the common case) writes to the exact path this pipeline used before
 * chunking existed — an existing brain dir full of monolithic one-chunk
 * "sessions" needs no migration, and mixes freely with newly-chunked ones.
 *
 * A forced reindex may shrink the chunk count (e.g. new content is shorter,
 * or preamble stripping now removes more). Chunk indices the new ingest
 * doesn't reuse are tombstoned (overwritten with empty content, same as the
 * files adapter's own `deleteSource`) so no stale chunk lingers in the index.
 *
 * Every failure is contained per-session: a session with no readable
 * transcript, with an empty transcript, or that throws mid-ingest is reported
 * in the result and never aborts the batch — the pipeline is resumable, so a
 * later run retries it.
 */

import type { ConversationTurn } from "@agentproto/corpus"
import type { IKnowledgeProvider, KnowledgeSource } from "@agentproto/knowledge-engine"
import {
  chunkTurns,
  chunkUri,
  DEFAULT_CHUNK_MAX_BYTES,
  renderChunkBody,
  renderChunkMarkdown,
} from "./chunking.js"
import type { BrainState } from "./brain-state.js"
import { BrainSessionSourcePort } from "./session-source-port.js"
import type {
  BrainStateRecord,
  ExportedSessionLike,
  IngestReport,
  IngestResult,
} from "./types.js"

export interface IngestPipelineOptions {
  /** Workspace bucket slug — surfaced in reports. */
  readonly workspace: string
  /** The injected transcript reader. */
  readonly readSession: (ref: string) => Promise<ExportedSessionLike | null>
  /** The persistent ingestion ledger. */
  readonly state: BrainState
  /** Lazy accessor for the backing knowledge provider (rooted at
   *  `brain/knowledge/`, so `ingest()` writes the expected source file). */
  readonly getProvider: () => IKnowledgeProvider
  /** Byte ceiling per chunk. Defaults to {@link DEFAULT_CHUNK_MAX_BYTES}. */
  readonly chunkMaxBytes?: number
  /** Optional — enumerate every session ref the workspace knows about.
   *  Omitted → `ingestPending` ingests nothing. */
  listSessionRefs?(): Promise<readonly string[]>
}

export class IngestPipeline {
  constructor(private readonly opts: IngestPipelineOptions) {}

  /** Ingest one session. `force` re-ingests even if already recorded. */
  async ingest(sessionId: string, force = false): Promise<IngestResult> {
    const { state, readSession, getProvider } = this.opts

    const existing = await state.read()
    const previous = existing[sessionId]
    if (!force) {
      if (previous) {
        return { sessionId, ok: true, skipped: "already-ingested" }
      }
    } else if (previous) {
      await state.forget(sessionId)
    }

    let session: ExportedSessionLike | null
    try {
      session = await readSession(sessionId)
    } catch {
      // A throwing reader is the same as an unreadable session — contained
      // per-session, never aborts the batch.
      await this.recordSkip(sessionId, "no-transcript")
      return { sessionId, ok: false, skippedReason: "no-transcript" }
    }
    if (!session) {
      await this.recordSkip(sessionId, "no-transcript")
      return { sessionId, ok: false, skippedReason: "no-transcript" }
    }

    try {
      const loaded = await this.importSingle(sessionId)
      if (!loaded) {
        await this.recordSkip(sessionId, "empty-transcript")
        return { sessionId, ok: false, skippedReason: "empty-transcript" }
      }

      const chunks = chunkTurns(loaded.turns, this.opts.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES)
      const chunkCount = chunks.length
      const provider = getProvider()
      const sourceIds: string[] = []
      let totalBytes = 0

      for (const chunk of chunks) {
        const markdown = renderChunkMarkdown({
          title: loaded.title,
          sessionId,
          chunkIndex: chunk.index,
          chunkCount,
          turnStart: chunk.turnStart,
          turnEnd: chunk.turnEnd,
          sessionTurnCount: loaded.turns.length,
          body: renderChunkBody(chunk.turns),
        })
        const ingested: KnowledgeSource = await provider.ingest({
          kind: "text",
          uri: chunkUri(sessionId, chunk.index),
          title: loaded.title,
          content: markdown,
          mimeType: "text/markdown",
          metadata: { sessionId, sourceKind: "conversation" },
        })
        sourceIds.push(ingested.id)
        totalBytes += ingested.bytes
      }

      // A shrinking reindex leaves old chunk indices >= the new count
      // orphaned on disk. Their uris are deterministic (chunkUri is a pure
      // function of sessionId + index), so regenerate and tombstone them —
      // no need to have recorded them anywhere beyond the old chunk count.
      const oldChunkCount = previous?.sourceIds?.length ?? (previous ? 1 : 0)
      for (let i = chunkCount; i < oldChunkCount; i++) {
        await provider.ingest({
          kind: "text",
          uri: chunkUri(sessionId, i),
          title: loaded.title,
          content: "",
          mimeType: "text/markdown",
          metadata: { sessionId, sourceKind: "conversation" },
        })
      }

      const record: BrainStateRecord = {
        sessionId,
        sourceId: sourceIds[0]!,
        sourceIds,
        ...(loaded.title ? { title: loaded.title } : {}),
        ingestedAt: new Date().toISOString(),
        turnCount: loaded.turns.length,
        bytes: totalBytes,
      }
      await state.record(record)

      return {
        sessionId,
        ok: true,
        sourceId: sourceIds[0]!,
        title: loaded.title,
        turnCount: loaded.turns.length,
        chunkCount,
      }
    } catch (err) {
      return {
        sessionId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Ingest every session the workspace knows about that isn't recorded yet
   *  and isn't recorded as skipped (see `BrainStateSkip`) — a skip is
   *  retried only by an explicit `ingest(sessionId)` call, never by the
   *  backlog. */
  async ingestPending(): Promise<IngestReport> {
    const listSessionRefs = this.opts.listSessionRefs
    if (!listSessionRefs) {
      return {
        workspace: this.opts.workspace,
        attempted: 0,
        ingested: 0,
        skipped: 0,
        failed: 0,
        results: [],
      }
    }
    const refs = await listSessionRefs()
    const [recorded, skips] = await Promise.all([
      this.opts.state.read(),
      this.opts.state.readSkips(),
    ])
    const pending = refs.filter(id => !recorded[id] && !skips[id])

    const results: IngestResult[] = []
    for (const id of pending) {
      results.push(await this.ingest(id))
    }
    const ingested = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok && r.error).length
    const skipped = results.length - ingested - failed
    return {
      workspace: this.opts.workspace,
      attempted: results.length,
      ingested,
      skipped,
      failed,
      results,
    }
  }

  /** Best-effort — persisting a skip is a courtesy for `pendingSessions`
   *  bookkeeping, not something a caller should see fail an ingest attempt
   *  that already has a perfectly good `skippedReason` to report. */
  private async recordSkip(
    sessionId: string,
    reason: "no-transcript" | "empty-transcript",
  ): Promise<void> {
    try {
      await this.opts.state.recordSkip(sessionId, reason)
    } catch {
      // ignore — see above
    }
  }

  /** Run the importer for a single session and return the first yielded
   *  source, or `null` when the transcript was empty/unusable. */
  private async importSingle(
    sessionId: string,
  ): Promise<{ title: string; turns: readonly ConversationTurn[] } | null> {
    const port = new BrainSessionSourcePort({ readSession: this.opts.readSession })
    const doc = await port.fetchConversation(sessionId)
    if (!doc || doc.turns.length === 0) return null
    return {
      title: (doc.title ?? `Conversation ${sessionId}`).slice(0, 200),
      turns: doc.turns,
    }
  }
}
