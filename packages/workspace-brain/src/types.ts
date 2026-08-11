/**
 * Shared types for the per-workspace brain.
 *
 * The brain is a pure engine: it knows how to turn a session's *exported
 * transcript* (an `ExportedSession`-shaped document — role/text/timestamp
 * turns) into an ingested, queryable knowledge source. It deliberately does
 * NOT know where transcripts come from; that bridge is injected through
 * {@link BrainConfig.readSession} by the host (the daemon wires it to
 * `CONVERSATION_STORES` + the `events.jsonl` fallback).
 */

/**
 * The minimal shape of a session's exported transcript that the brain
 * conflates to corpus `ConversationTurn`s — a structural slice of
 * `@agentproto/runtime`'s `ExportedSession` (`transcript-export.ts`). Kept
 * structural (not nominal) so this package never imports the runtime.
 */
export interface ExportedSessionLike {
  readonly meta?: { readonly title?: string }
  readonly messages: ReadonlyArray<{
    readonly role: string
    readonly text?: string
    readonly ts?: number
    readonly toolName?: string
  }>
}

/** One ingested session, as recorded in `brain-state.json`. */
export interface BrainStateRecord {
  readonly sessionId: string
  /** Stable source slug the transcript was ingested under (== stableSlug of
   *  the session id for ordinary ids — `sess-abc123` → `sources/sess-abc123.md`). */
  readonly sourceId: string
  readonly title?: string
  /** ISO-8601 ingest timestamp. */
  readonly ingestedAt: string
  readonly turnCount: number
  /** Content bytes written to disk. */
  readonly bytes: number
}

/**
 * Host-injected config — the one seam between this pure engine and the
 * real conversation stores of the world.
 */
export interface BrainConfig {
  /** Workspace bucket slug this brain belongs to (e.g. `agentik-studio`). */
  readonly workspace: string
  /** Absolute brain directory (`~/.agentproto/workspaces/<slug>/brain`). */
  readonly brainDir: string
  /**
   * Resolve a session reference to its exported transcript, or `null` when
   * the session has nothing readable (unknown, no store, empty). Returning
   * `null` makes the pipeline skip the session with a warning, never throw.
   */
  readSession(ref: string): Promise<ExportedSessionLike | null>
  /**
   * Optional — enumerate every session reference this workspace knows about
   * (used by `ingestPending`). Omitted → `ingestPending` becomes a no-op.
   */
  listSessionRefs?(): Promise<readonly string[]>
}

/** Outcome of ingesting a single session. */
export interface IngestResult {
  readonly sessionId: string
  readonly ok: boolean
  /** Set on success — the knowledge source the transcript landed as. */
  readonly sourceId?: string
  readonly title?: string
  readonly turnCount?: number
  /** Present when already ingested (and not forced). */
  readonly skipped?: "already-ingested"
  /** Present when `readSession` returned nothing usable. */
  readonly skippedReason?: "no-transcript" | "empty-transcript"
  /** Present on an unexpected failure. */
  readonly error?: string
}

/** Aggregate outcome of a `ingestPending` run. */
export interface IngestReport {
  readonly workspace: string
  readonly attempted: number
  readonly ingested: number
  readonly skipped: number
  readonly failed: number
  readonly results: readonly IngestResult[]
}

/** Snapshot of what the brain holds — surfaced by `workspace_brain_status`. */
export interface BrainStats {
  readonly workspace: string
  readonly brainDir: string
  /** Sessions ingested into the index. */
  readonly sourceCount: number
  /** Total content bytes on disk across sources. */
  readonly totalBytes: number
  /** Sessions that are known (from `listSessionRefs`) but not yet ingested. */
  readonly pendingSessions: number
  readonly lastIngestedAt?: string
  readonly ready: boolean
}
