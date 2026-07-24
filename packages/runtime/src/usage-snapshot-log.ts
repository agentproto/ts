/**
 * Reader for durable `kind: "usage_snapshot"` transcript records —
 * mirrors `tool-call-log.ts` / `command-log.ts`.
 *
 * Snapshots are WRITTEN by `transcript-writer.ts`'s `recordUsageSnapshot`
 * (every turn-end and at exit, via the buffered per-session append stream) —
 * this module only reads them back. It converges on the same per-id path an
 * agent-cli session's structured transcript uses
 * (`sessionEventsPath(sessionId, baseDir)`), parses JSONL line-by-line, keeps
 * only the `usage_snapshot` lines, and projects each to a `UsageSnapshotRecord`
 * (the pure rollup module's input shape).
 *
 * "Absence is not an error", same convention as `readCommandLogEntry` /
 * `readToolCallRecords`: a missing/unreadable file returns `[]`, and a single
 * malformed line is skipped rather than aborting the read.
 */

import { readFile } from "node:fs/promises"
import { sessionEventsPath } from "./transcript-writer.js"
import type { UsageSnapshotRecord } from "./usage-rollup.js"

/** Read back every `usage_snapshot` line from one session's events.jsonl, in
 *  on-disk order. Returns `[]` when the file is missing/unreadable or has no
 *  such lines; skips any malformed or non-`usage_snapshot` line. Never throws. */
export async function readUsageSnapshots(
  sessionId: string,
  baseDir?: string,
): Promise<UsageSnapshotRecord[]> {
  let raw: string
  try {
    raw = await readFile(sessionEventsPath(sessionId, baseDir), "utf8")
  } catch {
    return []
  }
  const out: UsageSnapshotRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (rec.kind !== "usage_snapshot") continue
    // `ts` is stamped by writeRecord; a snapshot missing it can't be windowed,
    // so skip it rather than emit an un-orderable record.
    if (typeof rec.ts !== "string") continue
    const source = rec.source
    if (
      source !== "adapter" &&
      source !== "computed" &&
      source !== "no-pricing" &&
      source !== "none"
    ) {
      continue
    }
    const record: UsageSnapshotRecord = { ts: rec.ts, source }
    if (typeof rec.costUsd === "number") record.costUsd = rec.costUsd
    if (typeof rec.tokensIn === "number") record.tokensIn = rec.tokensIn
    if (typeof rec.tokensOut === "number") record.tokensOut = rec.tokensOut
    if (typeof rec.model === "string") record.model = rec.model
    out.push(record)
  }
  return out
}
