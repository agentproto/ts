/**
 * `POST /host/processes/:pid/stop` — stop ONE process that belongs to a
 * daemon session, on behalf of an operator or an escalation session that
 * found it saturating the host (a whole-disk `find`/`bfs` scan, a runaway
 * build).
 *
 * The right is deliberately narrow, and it is enforced here, by the daemon,
 * not by whoever asks:
 *   - the target must be a DESCENDANT of a live session's adapter process
 *     (found by walking the parent chain up to a session root pid), never
 *     the session root itself (stopping a session is `/sessions/:id/kill`
 *     or a reap, which keep the registry consistent);
 *   - never the daemon, never one of the daemon's ancestors, never a process
 *     of another user, never a process outside every session (the
 *     operator's own shells, editors, system services);
 *   - SIGTERM first; SIGKILL only after `graceMs`, and only if the pid
 *     still runs the same command line (a recycled pid is left alone).
 *
 * Every attempt, allowed or refused, is appended to a JSONL log with who
 * asked and why, and an allowed stop is announced to the owning session as
 * a system notice, so the session learns what happened to its process.
 *
 * The decision ({@link authorizeStopProcess}) is a pure function of the
 * process table and the session list, unit-tested on its own; the runner
 * ({@link stopSessionProcess}) takes every effect as an injectable dep.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ProcRow } from "./process-stats.js"

/** Default log of every stop attempt. */
export function defaultStopProcessLogPath(): string {
  return join(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "host-stop-process.log")
}

/** How long a SIGTERM'd process gets before SIGKILL. */
export const DEFAULT_STOP_GRACE_MS = 5000
export const MAX_STOP_GRACE_MS = 60_000
/** Longest accepted `reason`. */
export const MAX_STOP_REASON_CHARS = 500

export type StopProcessRefusal =
  | "invalid-pid"
  | "daemon"
  | "daemon-ancestor"
  | "not-found"
  | "foreign-user"
  | "session-root"
  | "not-in-session"

/** The slice of a session the decision reads. */
export interface StopProcessSession {
  id: string
  pid?: number | null
  live: boolean
  label?: string
}

export interface StopProcessOwner {
  sessionId: string
  label?: string
  /** The session's adapter (root) pid the target descends from. */
  sessionPid: number
}

export interface StopProcessTarget {
  pid: number
  args: string
  elapsedSec: number
}

export type StopProcessDecision =
  | { ok: true; target: StopProcessTarget; owner: StopProcessOwner }
  | { ok: false; code: StopProcessRefusal; message: string }

/**
 * Whether `pid` may be stopped. Pure: same table, same sessions, same answer.
 * `uid` is the daemon's own uid (undefined skips the user check, e.g. on a
 * platform without uids).
 */
export function authorizeStopProcess(input: {
  pid: number
  table: readonly ProcRow[]
  sessions: readonly StopProcessSession[]
  daemonPid: number
  uid?: number
}): StopProcessDecision {
  const { pid, table, daemonPid } = input
  const refuse = (code: StopProcessRefusal, message: string): StopProcessDecision => ({ ok: false, code, message })
  if (!Number.isInteger(pid) || pid <= 1) return refuse("invalid-pid", `pid must be an integer above 1, got ${pid}`)
  if (pid === daemonPid) return refuse("daemon", `pid ${pid} is the daemon itself`)
  const byPid = new Map(table.map(r => [r.pid, r]))
  // The daemon's own ancestors (its launcher, the login shell, ...).
  for (let p = byPid.get(daemonPid)?.ppid, seen = new Set<number>(); p !== undefined && p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) {
    seen.add(p)
    if (p === pid) return refuse("daemon-ancestor", `pid ${pid} is an ancestor of the daemon`)
  }
  const row = byPid.get(pid)
  if (!row) return refuse("not-found", `no process with pid ${pid}`)
  if (input.uid !== undefined && row.uid !== input.uid) {
    return refuse("foreign-user", `pid ${pid} belongs to another user (uid ${row.uid})`)
  }
  const roots = new Map<number, StopProcessSession>()
  for (const s of input.sessions) {
    if (s.live && typeof s.pid === "number" && s.pid > 1) roots.set(s.pid, s)
  }
  const ownRoot = roots.get(pid)
  if (ownRoot) {
    return refuse(
      "session-root",
      `pid ${pid} is the process of session ${ownRoot.id} itself; stop the session instead (agentproto sessions kill)`,
    )
  }
  // Climb the parent chain: the first live session root found owns it. The
  // daemon is not a session: reaching it first means a daemon-side process.
  const seen = new Set<number>([pid])
  for (let p = row.ppid; p > 1 && !seen.has(p); p = byPid.get(p)?.ppid ?? 0) {
    seen.add(p)
    const s = roots.get(p)
    if (s) {
      return {
        ok: true,
        target: { pid, args: row.args, elapsedSec: row.elapsedSec },
        owner: { sessionId: s.id, ...(s.label ? { label: s.label } : {}), sessionPid: p },
      }
    }
    if (p === daemonPid) break
  }
  return refuse("not-in-session", `pid ${pid} does not descend from any live daemon session`)
}

export interface StopProcessRequest {
  pid: number
  reason: string
  /** Who asked: the attested caller session id, else `operator`. */
  by: string
  graceMs?: number
}

export interface StopProcessResult {
  ok: boolean
  pid: number
  /** Set when refused. */
  code?: StopProcessRefusal | "invalid-reason" | "signal-failed"
  message: string
  owner?: StopProcessOwner
  target?: StopProcessTarget
  /** Last signal sent. */
  signal?: "SIGTERM" | "SIGKILL"
  /** The process is gone at the end of the call. */
  exited?: boolean
  /** The owning session was told. */
  notified?: boolean
}

export interface StopProcessDeps {
  table: () => Promise<ProcRow[]>
  sessions: () => readonly StopProcessSession[]
  daemonPid: number
  uid?: number
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  /** True while `pid` still exists. */
  alive: (pid: number) => boolean
  /** True when `pid` has exited but its parent has not reaped it yet (it
   *  still answers `alive`). Absent: no such check. */
  isZombie?: (pid: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  /** Appends one record to the log; failures are swallowed by the runner. */
  log: (record: Record<string, unknown>) => Promise<void>
  /** Tells the owning session; resolves false when it could not. */
  notify: (owner: StopProcessOwner, text: string, data: Record<string, unknown>) => Promise<boolean>
  now?: () => Date
}

/** Appends a JSON line to `path` (directories created as needed). */
export function jsonlLogger(path: string): (record: Record<string, unknown>) => Promise<void> {
  return async record => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(record) + "\n", "utf8")
  }
}

/** Authorize, stop, log, notify. Never throws for a refusal: the result
 *  says what happened, and the log has the same record. */
export async function stopSessionProcess(req: StopProcessRequest, deps: StopProcessDeps): Promise<StopProcessResult> {
  const now = deps.now ?? (() => new Date())
  const reason = req.reason.trim()
  const graceMs = Math.min(Math.max(0, Math.floor(req.graceMs ?? DEFAULT_STOP_GRACE_MS)), MAX_STOP_GRACE_MS)
  const record = async (result: StopProcessResult): Promise<StopProcessResult> => {
    try {
      await deps.log({
        at: now().toISOString(),
        by: req.by,
        reason,
        pid: req.pid,
        ok: result.ok,
        ...(result.code ? { code: result.code } : {}),
        message: result.message,
        ...(result.target ? { args: result.target.args, elapsedSec: result.target.elapsedSec } : {}),
        ...(result.owner ? { ownerSessionId: result.owner.sessionId, ownerLabel: result.owner.label } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.exited !== undefined ? { exited: result.exited } : {}),
        ...(result.notified !== undefined ? { notified: result.notified } : {}),
      })
    } catch {
      // The log is evidence, not a precondition: a full disk must not block
      // relieving a saturated host.
    }
    return result
  }
  if (!reason || reason.length > MAX_STOP_REASON_CHARS) {
    return record({
      ok: false,
      pid: req.pid,
      code: "invalid-reason",
      message: `a reason of 1 to ${MAX_STOP_REASON_CHARS} characters is required`,
    })
  }
  const table = await deps.table()
  const decision = authorizeStopProcess({
    pid: req.pid,
    table,
    sessions: deps.sessions(),
    daemonPid: deps.daemonPid,
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
  })
  if (!decision.ok) return record({ ok: false, pid: req.pid, code: decision.code, message: decision.message })

  const { target, owner } = decision
  let signal: "SIGTERM" | "SIGKILL" = "SIGTERM"
  try {
    deps.kill(target.pid, "SIGTERM")
  } catch (err) {
    return record({
      ok: false,
      pid: req.pid,
      code: "signal-failed",
      message: `SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`,
      owner,
      target,
    })
  }
  const step = 100
  for (let waited = 0; waited < graceMs && deps.alive(target.pid); waited += step) await deps.sleep(step)
  if (deps.alive(target.pid)) {
    // Same pid, same command line: still our process, not a recycled pid.
    const again = (await deps.table()).find(r => r.pid === target.pid)
    if (again && again.args === target.args) {
      signal = "SIGKILL"
      try {
        deps.kill(target.pid, "SIGKILL")
      } catch {
        // Gone between the check and the signal.
      }
      await deps.sleep(step)
    }
  }
  const exited = !deps.alive(target.pid) || (deps.isZombie ? await deps.isZombie(target.pid) : false)
  const who = owner.label ? `${owner.sessionId} (${owner.label})` : owner.sessionId
  const text =
    `The daemon stopped process ${target.pid} of this session (${signal}): \`${clip(target.args, 200)}\`. ` +
    `Requested by ${req.by}. Reason: ${reason}. ` +
    `If the work still matters, run it again in a narrower form (a scoped path instead of the whole disk).`
  let notified = false
  try {
    notified = await deps.notify(owner, text, {
      pid: target.pid,
      args: clip(target.args, 500),
      signal,
      exited,
      by: req.by,
      reason,
    })
  } catch {
    notified = false
  }
  return record({
    ok: true,
    pid: target.pid,
    message: `${exited ? "stopped" : "signalled"} pid ${target.pid} of session ${who} with ${signal}`,
    owner,
    target,
    signal,
    exited,
    notified,
  })
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
