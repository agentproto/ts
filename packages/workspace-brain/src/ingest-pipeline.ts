/**
 * The ingest pipeline — turn a workspace's session transcripts into queryable
 * knowledge sources.
 *
 * For each session not yet ingested (or forced), the pipeline:
 *   1. resolves its exported transcript through the injected `readSession`,
 *   2. feeds it to corpus's `ConversationImporter` via a
 *      {@link BrainSessionSourcePort} (yielding a source with slug, title,
 *      rendered body and turn stats),
 *   3. renders a markdown document (frontmatter + transcript body) and routes
 *      it through `provider.ingest()`, which writes
 *      `<brain>/knowledge/sources/<session-id>.md` AND invalidates the engine's
 *      BM25 cache (so a subsequent query sees it immediately),
 *   4. records the ingestion in `brain-state.json`.
 *
 * Every failure is contained per-session: a session with no readable
 * transcript, with an empty transcript, or that throws mid-ingest is reported
 * in the result and never aborts the batch — the pipeline is resumable, so a
 * later run retries it.
 */

import { ConversationImporter } from "@agentproto/corpus"
import type { IKnowledgeProvider, KnowledgeSource } from "@agentproto/knowledge-engine"
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
  /** Optional — enumerate every session ref the workspace knows about.
   *  Omitted → `ingestPending` ingests nothing. */
  listSessionRefs?(): Promise<readonly string[]>
}

export class IngestPipeline {
  constructor(private readonly opts: IngestPipelineOptions) {}

  /** Ingest one session. `force` re-ingests even if already recorded. */
  async ingest(sessionId: string, force = false): Promise<IngestResult> {
    const { state, readSession, getProvider } = this.opts

    if (!force) {
      const already = await state.read()
      if (already[sessionId]) {
        return { sessionId, ok: true, skipped: "already-ingested" }
      }
    } else {
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
      const source = await this.importSingle(sessionId)
      if (!source) {
        await this.recordSkip(sessionId, "empty-transcript")
        return { sessionId, ok: false, skippedReason: "empty-transcript" }
      }

      const markdown = renderSourceMarkdown(source, sessionId)
      const ingested: KnowledgeSource = await getProvider().ingest({
        kind: "text",
        uri: sessionId,
        title: source.title,
        content: markdown,
        mimeType: "text/markdown",
        metadata: { sessionId, sourceKind: "conversation" },
      })

      const record: BrainStateRecord = {
        sessionId,
        sourceId: ingested.id,
        ...(source.title ? { title: source.title } : {}),
        ingestedAt: new Date().toISOString(),
        turnCount: source.turnCount,
        bytes: ingested.bytes,
      }
      await state.record(record)

      return {
        sessionId,
        ok: true,
        sourceId: ingested.id,
        title: source.title,
        turnCount: source.turnCount,
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
  ): Promise<
    | { title: string; body: string; turnCount: number; slug: string }
    | null
  > {
    const port = new BrainSessionSourcePort({ readSession: this.opts.readSession })
    const importer = new ConversationImporter({ source: port })

    for await (const src of importer.enumerate({
      importerId: "workspace-brain",
      config: { refs: [sessionId] },
    })) {
      const meta = (src.corpusMetadata ?? {}) as { turnCount?: number }
      return {
        title: src.title,
        body: src.body,
        turnCount: typeof meta.turnCount === "number" ? meta.turnCount : 0,
        slug: src.slug,
      }
    }
    return null
  }
}

/** Minimal renderer for an ingested session's source document — matches the
 *  adapter's `parseFrontmatterMetadata` (flat `key: value` frontmatter), so
 *  `query`/`listSources`/`getSource` surface session provenance on every hit. */
function renderSourceMarkdown(
  source: { title: string; body: string; slug: string; turnCount: number },
  sessionId: string,
): string {
  const lines = [
    "---",
    `title: ${source.title.replace(/:/g, " -")}`,
    `sessionId: ${sessionId}`,
    `slug: ${source.slug}`,
    "sourceKind: conversation",
    `turnCount: ${source.turnCount}`,
    "---",
    "",
    `# ${source.title}`,
    "",
    source.body,
    "",
  ]
  return lines.join("\n")
}
