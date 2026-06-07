/**
 * FootprintIndexPort — the ANALYTICAL index seam (the 4th sink).
 *
 * Capture fans out to corpus (voice → twin), graph (network traversal), and —
 * once a host wires an engine — this flat columnar index for scan/aggregate
 * queries at scale: top-engagers-over-time, post cadence, media inventory,
 * co-engagement matrices. The kind of thing slow in a graph and impossible in
 * prose. A swappable engine adapter (ClickHouse / DuckDB / BigQuery) injects
 * the impl; this kit only defines the contract + the denormalized row shapes.
 *
 * No implementation lives here on purpose — it's the forward-compat seam so the
 * index drops in without re-touching the model. The `footprintToIndexRows`
 * mapper ships alongside the first engine adapter.
 */

import type { Slice, FootprintRecord, MediaRef } from "../model/footprint.js"

/** One denormalized row per FootprintRecord — built for columnar scan. */
export interface FootprintIndexRow {
  readonly platform: string
  /** Whose footprint this row belongs to (the capture subject). */
  readonly subjectHandle: string
  readonly slice: Slice
  readonly recordKind: FootprintRecord["kind"]
  /** Post / engagement-target urn, when the row references a post. */
  readonly urn?: string | null
  readonly subtype?: string | null
  readonly authorHandle?: string | null
  /** The other party — engager, target author, or connection person. */
  readonly counterpartyHandle?: string | null
  readonly action?: string | null
  readonly edge?: string | null
  readonly direction?: string | null
  readonly text?: string | null
  readonly url?: string | null
  /** Source event time (post/engagement), ISO 8601. */
  readonly createdAt?: string | null
  readonly numLikes?: number | null
  readonly numComments?: number | null
  readonly numReposts?: number | null
  readonly mediaCount?: number | null
  /** When this row was indexed, ISO 8601. */
  readonly capturedAt: string
}

/** One row per attached media — references the object-store key when archived. */
export interface MediaIndexRow {
  readonly platform: string
  readonly subjectHandle: string
  readonly postUrn: string
  readonly type: MediaRef["type"]
  readonly url: string
  readonly sha256?: string | null
  readonly storageKey?: string | null
  readonly bytes?: number | null
  readonly width?: number | null
  readonly height?: number | null
  readonly durationMs?: number | null
  readonly alt?: string | null
}

/**
 * Sink for the analytical index. Idempotent upsert (re-running a capture must
 * not double-count) — the engine keys on (subjectHandle, urn[, counterparty]).
 */
export interface FootprintIndexPort {
  /** Engine id, for diagnostics — e.g. "clickhouse", "duckdb". */
  readonly engine: string
  upsertFootprint(
    rows: readonly FootprintIndexRow[]
  ): Promise<{ upserted: number }>
  upsertMedia(rows: readonly MediaIndexRow[]): Promise<{ upserted: number }>
}
