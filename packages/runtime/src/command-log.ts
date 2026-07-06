/**
 * Per-session JSONL record of a completed `command_execute` invocation
 * (and cron's `kind: "command"` action jobs, which share the same
 * allowlist + `runCommand` path — see cron-scheduler.ts's "one
 * enforcement path, not two" comment).
 *
 * Each call gets its OWN `kind: "command"` session, minted via
 * `SessionsRegistry.recordCommand` — same as an agent-cli or PTY session,
 * so it shows up in `session_list` / `command_list` for free instead of
 * needing a bespoke query surface. Its result is stored at the exact
 * per-id path an agent-cli session's structured transcript already uses:
 * `~/.agentproto/sessions/<id>/events.jsonl` (see transcript-writer.ts).
 * A command session's file holds exactly one line — there's no seq/turn
 * machinery to reconstruct because the call is already finished by the
 * time this is written.
 *
 * This module only knows how to read/write that one line; minting the
 * session itself (and deciding the file's base directory) is
 * `sessions.ts`'s job via `recordCommand`.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { sessionEventsPath } from "./transcript-writer.js"

export interface CommandLogEntry {
  ts: string
  command: string
  args: string[]
  cwd: string
  exitCode: number
  signal: string | null
  durationMs: number
  stdout: string
  stderr: string
  truncated?: boolean
}

/** Append the entry to `<sessionId>`'s events.jsonl. Fire-and-forget —
 *  never throws; a failure is logged and dropped, matching the
 *  `persistSnapshot` best-effort convention in sessions.ts. A full disk
 *  or a permissions problem under `.agentproto/` must never break the
 *  command the caller actually asked to run. */
export function writeCommandLogEntry(
  sessionId: string,
  entry: CommandLogEntry,
  baseDir?: string,
): Promise<void> {
  const path = sessionEventsPath(sessionId, baseDir)
  // Returns the write promise so callers CAN await it (tests do, to avoid a
  // flaky fixed-delay read); the daemon stays fire-and-forget by `void`-ing
  // the result. The internal `.catch` keeps an un-awaited call from ever
  // rejecting, so fire-and-forget is still safe.
  return mkdir(dirname(path), { recursive: true })
    .then(() => appendFile(path, `${JSON.stringify(entry)}\n`, "utf8"))
    .catch(err => {
      console.warn(`[command-log] failed to write entry for session ${sessionId}:`, err)
    })
}

/** Read back a command session's logged entry. Returns null when the
 *  file is missing, empty, or unreadable (e.g. the daemon was killed
 *  before the fire-and-forget write landed) — callers treat that as
 *  "no result recorded" rather than an error. */
export async function readCommandLogEntry(
  sessionId: string,
  baseDir?: string,
): Promise<CommandLogEntry | null> {
  try {
    const raw = await readFile(sessionEventsPath(sessionId, baseDir), "utf8")
    const line = raw.split("\n").find(l => l.trim().length > 0)
    if (!line) return null
    return JSON.parse(line) as CommandLogEntry
  } catch {
    return null
  }
}
