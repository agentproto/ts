/**
 * Structured JSONL audit log for `command_execute` (and cron's
 * `kind: "command"` action jobs — see cron-scheduler.ts, which already
 * shares `command-tools.ts`'s `loadAllowlist`/`runCommand` under its own
 * "one enforcement path, not two" rule; logging follows the same path
 * for the same reason).
 *
 * One line per invocation, one file per calendar day, per workspace:
 * `<workspace>/.agentproto/command-log/<YYYY-MM-DD>.jsonl`. Day-bucketing
 * gives the log a free, zero-maintenance rotation — no size cap or
 * pruning job needed, an operator can just delete old date files.
 *
 * Entries mirror `ExecuteResult` verbatim (plus the invocation's inputs).
 * `stdout`/`stderr` are already capped per stream at `STREAM_BUFFER_CAP`
 * by `runCommand` before this module ever sees them — this is a
 * durability log of what the caller already received, not a second
 * place to reinvent truncation policy.
 *
 * Append is best-effort: failures are logged via `console.warn` and
 * swallowed, matching the `persistSnapshot` convention in sessions.ts —
 * a full disk or a permissions problem under `.agentproto/` must never
 * break the command the caller actually asked to run.
 */

import { existsSync, statSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { ExecuteResult } from "./command-tools.js"

export const COMMAND_LOG_DIR_REL = ".agentproto/command-log"

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

function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}

export function commandLogDir(workspace: string): string {
  return resolve(workspace, COMMAND_LOG_DIR_REL)
}

export function commandLogPath(workspace: string, day: string = dayBucket(new Date())): string {
  return join(commandLogDir(workspace), `${day}.jsonl`)
}

export interface AppendCommandLogInput {
  command: string
  args: string[]
  cwd: string
}

/** Append one entry for a completed `runCommand()` call. Fire-and-forget
 *  from the caller's point of view — never throws; a failure is logged
 *  and dropped. */
export async function appendCommandLogEntry(
  workspace: string,
  input: AppendCommandLogInput,
  result: ExecuteResult,
): Promise<void> {
  const entry: CommandLogEntry = {
    ts: new Date().toISOString(),
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.truncated ? { truncated: true } : {}),
  }
  try {
    await mkdir(commandLogDir(workspace), { recursive: true })
    await appendFile(commandLogPath(workspace), `${JSON.stringify(entry)}\n`, "utf8")
  } catch (err) {
    console.warn(`[command-log] failed to append entry for workspace ${workspace}:`, err)
  }
}

export interface TailCommandLogOptions {
  /** Max entries to return, newest last (same convention as agent_output's
   *  ring-buffer tail). Default 50. */
  lastN?: number
  /** Only scan day-files at or after this `YYYY-MM-DD` cursor. Omit to
   *  scan backwards from the most recent day until `lastN` is filled. */
  since?: string
}

/** Read back the most recent command-log entries for a workspace, newest
 *  last. Scans day-files newest-first and stops once `lastN` is
 *  satisfied, so a long-lived workspace with years of daily files doesn't
 *  get fully read on every call. Malformed lines (partial write mid-crash)
 *  are skipped rather than failing the whole tail. */
export async function tailCommandLog(
  workspace: string,
  opts?: TailCommandLogOptions,
): Promise<CommandLogEntry[]> {
  const dir = commandLogDir(workspace)
  const limit = opts?.lastN ?? 50
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(".jsonl"))
  } catch {
    return []
  }
  files.sort() // "YYYY-MM-DD.jsonl" sorts lexicographically == chronologically
  if (opts?.since) {
    files = files.filter(f => f >= `${opts.since}.jsonl`)
  }
  files.reverse() // newest day first

  const collected: CommandLogEntry[] = []
  for (const file of files) {
    if (collected.length >= limit) break
    let raw: string
    try {
      raw = await readFile(join(dir, file), "utf8")
    } catch {
      continue
    }
    const parsed: CommandLogEntry[] = []
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue
      try {
        parsed.push(JSON.parse(line) as CommandLogEntry)
      } catch {
        // Skip a malformed line (e.g. torn write mid-crash) rather than
        // failing the whole tail.
      }
    }
    const room = limit - collected.length
    collected.unshift(...parsed.slice(-room))
  }
  return collected.slice(-limit)
}

/**
 * Cheap, synchronous check for whether a workspace already has a
 * nonempty command log — used at spawn time (`spawnAgent`/`spawnPty` in
 * sessions.ts) to decide whether a new session's descriptor should carry
 * a `priorCommandLogRef` pointer. Synchronous because both spawn paths
 * are themselves synchronous; this is at most `lookbackDays` stat calls
 * against a directory that's typically empty or holds one file per day.
 *
 * Scans backwards from today so a session spawned just after local
 * midnight still finds "yesterday's" log instead of reporting nothing.
 */
export function findRecentCommandLogRef(
  workspace: string,
  opts?: { lookbackDays?: number },
): string | undefined {
  const dir = commandLogDir(workspace)
  if (!existsSync(dir)) return undefined
  const lookback = opts?.lookbackDays ?? 7
  const now = Date.now()
  for (let i = 0; i < lookback; i++) {
    const day = dayBucket(new Date(now - i * 86_400_000))
    try {
      const st = statSync(commandLogPath(workspace, day))
      if (st.size > 0) {
        return `${COMMAND_LOG_DIR_REL}/${day}.jsonl`
      }
    } catch {
      // No file for this day — keep scanning backwards.
    }
  }
  return undefined
}
