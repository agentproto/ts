/**
 * Size ceilings for the workspace-brain ingest reader.
 *
 * The brain ingests a whole session by materializing `events.jsonl` into one
 * `ExportedMessage[]` (see `transcript-export.ts`), then chunks it. A
 * multi-hundred-MB transcript therefore becomes one very large array in a
 * single burst, which is the heap-growth suspect this cap exists to bound.
 *
 * Two ceilings, because they catch different explosions:
 *   - `maxTranscriptBytes` is checked against the FILE size before a line is
 *     parsed, so an oversized capture is refused without reading it at all.
 *   - `maxTranscriptTextBytes` is a running ceiling on accumulated message
 *     text while parsing: a small JSONL can still expand into a large
 *     transcript (repetitive delta records, escaped strings, command output).
 *
 * A third ceiling bounds the QUERY side: `maxIndexDocs` caps how many files a
 * brain's `files` provider indexes in process (its BM25 index is rebuilt from
 * every file of the brain after an ingest). Above it the provider refuses to
 * build and the query fails with the reason.
 *
 * All are defaults, overridable under `defaults.reactions.brainIngest` in
 * `~/.agentproto/config.json`. Explicit operator exports (session transcript,
 * conversation read/export, checkpoints) do NOT pass these limits — only the
 * brain reader does.
 */

import { DEFAULT_MAX_INDEX_DOCS } from "@agentproto/workspace-brain"

/** 32 MB. A normal long agent session is a few MB of JSONL; 32 MB is well
 *  above that and still bounded. */
export const DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024

/** 8 MB of extracted message text. The brain chunks the transcript at 3.5 KB
 *  per source (`DEFAULT_CHUNK_MAX_BYTES`), so even a few MB is hundreds of
 *  sources; past 8 MB the ingested-and-queryable value no longer justifies the
 *  memory burst. */
export const DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES = 8 * 1024 * 1024

/** 100,000 files: the `files` provider's own default (see
 *  `DEFAULT_MAX_INDEX_DOCS` in `@agentproto/adapter-knowledge-files`). */
export const DEFAULT_BRAIN_MAX_INDEX_DOCS = DEFAULT_MAX_INDEX_DOCS

export interface BrainIngestLimitConfig {
  /** File-size ceiling for `events.jsonl`, in bytes. */
  readonly maxTranscriptBytes?: number
  /** Running ceiling on accumulated message text, in bytes. */
  readonly maxTranscriptTextBytes?: number
  /** Ceiling on the files one brain indexes in process. */
  readonly maxIndexDocs?: number
}

export interface BrainIngestLimits {
  readonly maxTranscriptBytes: number
  readonly maxTranscriptTextBytes: number
  readonly maxIndexDocs: number
}

/** Resolve configured ceilings, falling back per-field to the defaults for
 *  anything absent, non-positive, or non-finite. */
export function resolveBrainIngestLimits(
  config?: BrainIngestLimitConfig,
): BrainIngestLimits {
  return {
    maxTranscriptBytes: positiveOr(
      config?.maxTranscriptBytes,
      DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES,
    ),
    maxTranscriptTextBytes: positiveOr(
      config?.maxTranscriptTextBytes,
      DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES,
    ),
    maxIndexDocs: positiveOr(config?.maxIndexDocs, DEFAULT_BRAIN_MAX_INDEX_DOCS),
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback
}
