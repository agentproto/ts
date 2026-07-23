/**
 * Durable I/O for `ToolCallRecord` (tool-call-record.ts) — appends a
 * `kind: "tool-call-record"`-tagged line to a session's `events.jsonl` and
 * reads them back.
 *
 * Used directly by the proxy path (`recordCommand` in sessions.ts, via
 * `writeToolCallRecord`, mirroring `writeCommandLogEntry`'s fire-and-forget
 * `appendFile` — a command session never calls into `transcript-writer.ts`,
 * see its own module comment). The in-agent path does NOT use
 * `writeToolCallRecord`: `transcript-writer.ts` already owns a buffered,
 * seq-numbered append stream per session, so it writes its
 * `tool-call-record` line through that instead (see its `"tool-result"`
 * case) — reusing this module's write path there would race two independent
 * appenders against the same file. Both paths converge on `readToolCallRecords`.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { sessionEventsPath } from "./transcript-writer.js"
import type { ToolCallRecord } from "./tool-call-record.js"

interface ToolCallRecordLine extends ToolCallRecord {
  kind: "tool-call-record"
}

/** Append a `ToolCallRecord` line to `<sessionId>`'s events.jsonl. Fire-and-
 *  forget — never throws; a failure is logged and dropped, same convention
 *  as `writeCommandLogEntry`. */
export function writeToolCallRecord(record: ToolCallRecord, baseDir?: string): Promise<void> {
  const path = sessionEventsPath(record.sessionId, baseDir)
  const line: ToolCallRecordLine = { kind: "tool-call-record", ...record }
  return mkdir(dirname(path), { recursive: true })
    .then(() => appendFile(path, `${JSON.stringify(line)}\n`, "utf8"))
    .catch(err => {
      console.warn(`[tool-call-log] failed to write record for session ${record.sessionId}:`, err)
    })
}

/** Read back every `ToolCallRecord` line from one session's events.jsonl,
 *  in on-disk order. Returns `[]` when the file is missing/unreadable or
 *  has no such lines — "absence is not an error", same convention as
 *  `readCommandLogEntry`. */
export async function readToolCallRecords(
  sessionId: string,
  baseDir?: string,
): Promise<ToolCallRecord[]> {
  let raw: string
  try {
    raw = await readFile(sessionEventsPath(sessionId, baseDir), "utf8")
  } catch {
    return []
  }
  const out: ToolCallRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (rec.kind !== "tool-call-record") continue
    const { kind: _kind, seq: _seq, ...rest } = rec
    out.push(rest as unknown as ToolCallRecord)
  }
  return out
}
