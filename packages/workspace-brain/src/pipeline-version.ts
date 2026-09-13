/**
 * The ingest pipeline's content version — bump this whenever a change to
 * `session-source-port.ts`, `chunking.ts`, or `ingest-pipeline.ts` would
 * produce materially different chunk content for a transcript that was
 * already ingested (e.g. the harness-preamble-stripping fix in #1012).
 *
 * Every `BrainStateRecord` is stamped with the version that produced it.
 * `ingestPending()`'s convergence design (skip anything already recorded —
 * see `d63cd316`/`632b0111`) means a version bump alone does NOT retroactively
 * refresh previously-ingested sources; it only lets the pipeline notice and
 * report that they're now behind. That report is what this module exists
 * to make possible — see `isStaleRecord` below and its callers in
 * `ingest-pipeline.ts` (`ingestPending`'s `staleSources` + optional
 * `reindexStale`) and `brain-manager.ts` (`status()`'s `staleSources`).
 *
 * A record written before this field existed has no `pipelineVersion` at
 * all, which `isStaleRecord` treats as version 0 — always stale, so old data
 * is flagged rather than silently assumed current.
 */
export const PIPELINE_VERSION = 1

/** `true` when `record` was ingested by an older pipeline version than the
 *  code running now. A missing `pipelineVersion` (data ingested before this
 *  field existed) counts as version 0, i.e. always stale. */
export function isStaleRecord(record: { readonly pipelineVersion?: number }): boolean {
  return (record.pipelineVersion ?? 0) < PIPELINE_VERSION
}
