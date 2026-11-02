/**
 * Reader for durable `kind: "usage_snapshot"` transcript records —
 * mirrors `tool-call-log.ts` / `command-log.ts`.
 *
 * Snapshots are WRITTEN by `transcript-writer.ts`'s `recordUsageSnapshot`
 * (every turn-end and at exit, via the buffered per-session append stream) —
 * this module only reads them back. It converges on the same per-id path an
 * agent-cli session's structured transcript uses
 * (`sessionEventsPath(sessionId, baseDir)`), streams the JSONL line by line,
 * keeps only the `usage_snapshot` lines, and projects each to a
 * `UsageSnapshotRecord` (the pure rollup module's input shape).
 *
 * Streamed, never read whole: a transcript can be hundreds of MB, and
 * `collectSessionSnapshots` reads every agent-cli session's. Reading each one
 * into a single string and `JSON.parse`-ing every line made one rollup cost
 * the sum of the transcripts in heap (E99). A line that does not mention
 * `usage_snapshot` is skipped before any parse.
 *
 * "Absence is not an error", same convention as `readCommandLogEntry` /
 * `readToolCallRecords`: a missing/unreadable file returns `[]`, and a single
 * malformed line is skipped rather than aborting the read.
 */

import { open } from "node:fs/promises"
import { createInterface } from "node:readline"
import { sessionEventsPath } from "./transcript-writer.js"
import type { UsageSnapshotRecord } from "./usage-rollup.js"

/** Read back every `usage_snapshot` line from one session's events.jsonl, in
 *  on-disk order. Returns `[]` when the file is missing/unreadable or has no
 *  such lines; skips any malformed or non-`usage_snapshot` line. Never throws. */
export async function readUsageSnapshots(
  sessionId: string,
  baseDir?: string,
): Promise<UsageSnapshotRecord[]> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(sessionEventsPath(sessionId, baseDir), "r")
  } catch {
    return []
  }
  const out: UsageSnapshotRecord[] = []
  const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8", autoClose: false }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes("usage_snapshot")) continue
      const record = parseUsageSnapshotLine(line)
      if (record) out.push(record)
    }
  } catch {
    return []
  } finally {
    lines.close()
    await handle.close().catch(() => {})
  }
  return out
}

function parseUsageSnapshotLine(line: string): UsageSnapshotRecord | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let rec: Record<string, unknown>
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (rec.kind !== "usage_snapshot") return undefined
  // `ts` is stamped by writeRecord; a snapshot missing it can't be windowed,
  // so skip it rather than emit an un-orderable record.
  if (typeof rec.ts !== "string") return undefined
  const source = rec.source
  if (
    source !== "adapter" &&
    source !== "computed" &&
    source !== "no-pricing" &&
    source !== "none"
  ) {
    return undefined
  }
  const record: UsageSnapshotRecord = { ts: rec.ts, source }
  if (typeof rec.costUsd === "number") record.costUsd = rec.costUsd
  if (typeof rec.tokensIn === "number") record.tokensIn = rec.tokensIn
  if (typeof rec.tokensOut === "number") record.tokensOut = rec.tokensOut
  // Cache split: the writer records it on every snapshot that carries it
  // (claude-code's transcript reader, hermes state.db, opencode.db). A
  // snapshot without it keeps the field ABSENT, never a 0.
  if (typeof rec.cacheReadTokens === "number") record.cacheReadTokens = rec.cacheReadTokens
  if (typeof rec.cacheWriteTokens === "number") record.cacheWriteTokens = rec.cacheWriteTokens
  if (typeof rec.reasoningTokens === "number") record.reasoningTokens = rec.reasoningTokens
  if (typeof rec.model === "string") record.model = rec.model
  return record
}
