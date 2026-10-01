/**
 * `agentproto sessions board [--json] [--watch] [--all]`
 *
 * A glanceable session-status board: one cheap snapshot, every session
 * classified into a single Badge, sorted by attention-worthiness, with a
 * one-line summary header. Built on the SAME raw rows the `sessions list`
 * verb already fetches (`GET /sessions`) — no new daemon surface, and
 * `kind:"command"` log rows ride in via the existing `?includeCommands=true`
 * opt-in (the same rows `command_list` returns) only under `--all`.
 *
 * Classification rules (frozen — one Badge per session, first match wins):
 *
 *   BADGE      CONDITION
 *   ---------  ------------------------------------------------------------
 *   COMMAND    kind === "command" (only ever present under `--all`).
 *   ENDED      status is terminal (exited / killed / error); endedReason kept
 *              as evidence.
 *   BLOCKED    blockedOn is set (waiting on a subagent / command / inbox) —
 *              a harder wedge than a conversational question, checked first.
 *   AWAITING   awaitingInput (human/orchestrator question) OR
 *              awaitingPermission (parked permission decision).
 *   ACTIVE     status running|starting AND busy (a turn is in flight).
 *   STALE      running, NOT busy, NO keepAlive, and past the reap-risk age
 *              (idleMs > staleAfterMs) — or interrupted:true, which marks a
 *              mid-turn cut that will never wake on its own regardless of
 *              age. These are the rows the idle-reaper would retire.
 *   IDLE       running, not busy — anything else still alive (young rows,
 *              and keepAlive:true rows which are NEVER STALE).
 *
 * Sort order (attention-worthiness, high → low):
 *   AWAITING > BLOCKED > STALE > ACTIVE > IDLE > COMMAND > ENDED.
 *
 * The classifier (`classifySessions`) is a PURE function over the fetched
 * rows + an injected clock — same discipline as `session-presence.ts` and
 * the idle-reaper's policy pass. Rendering and the watch loop live below;
 * nothing here reads config, fs, or timers.
 */
import { parseArgs } from "node:util"
import type { SessionDescriptor } from "@agentproto/runtime"
import {
  discoverDaemon,
  httpGetJson,
  printNoDaemonError,
  humaniseDelta,
} from "./_daemon-helpers.js"

/** Structural input row — the slice of `SessionDescriptor` the classifier
 *  reads. Declared as a Pick so real HTTP rows typecheck unchanged and
 *  tests can pass minimal literals. */
export type BoardSession = Pick<
  SessionDescriptor,
  | "id"
  | "kind"
  | "status"
  | "busy"
  | "awaitingInput"
  | "awaitingPermission"
  | "blockedOn"
  | "keepAlive"
  | "interrupted"
  | "continuedFrom"
  | "lastActivityAt"
  | "startedAt"
  | "name"
  | "model"
  | "costUsd"
  | "depth"
  | "parentSessionId"
  | "endedReason"
>

export type SessionBoardBadge =
  | "AWAITING"
  | "BLOCKED"
  | "STALE"
  | "ACTIVE"
  | "IDLE"
  | "COMMAND"
  | "ENDED"

/** Fallback reap-risk age for the STALE badge. The daemon's own
 *  `daemon.idleReapAfterMs` knob is OFF by default (the idle-reaper is
 *  opt-in), so the board uses its own conservative default: a non-busy
 *  agent session that has sat untouched this long is treated as
 *  reap-risk STALE. */
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000

const TERMINAL_STATUSES = new Set(["exited", "killed", "error"])

/** One classified session: the Badge plus every evidence field the rules
 *  above read, so `--json` consumers can re-derive or audit the class. */
export interface ClassifiedSession {
  badge: SessionBoardBadge
  id: string
  /** Human label: `name` if given, else the id. */
  label: string
  kind: string
  status: SessionDescriptor["status"]
  busy?: boolean
  awaitingInput?: boolean
  awaitingPermission?: boolean
  blockedOn?: SessionDescriptor["blockedOn"]
  keepAlive?: boolean
  interrupted?: boolean
  /** Handoff edge — the row this one continued from (resume/continue). */
  continuedFrom?: string
  /** Idle age in ms, from `lastActivityAt` (falling back to `startedAt`);
   *  null when the row is un-ageable (missing/unparseable timestamps). */
  idleMs: number | null
  /** Human idle-age cell, e.g. `12m`; `?` when un-ageable. */
  age: string
  /** Model id, only when the adapter reported one (omitted otherwise). */
  model?: string
  /** Cumulative cost, ONLY when usage exists (`costUsd` present on the
   *  row) — omitted otherwise so `--json` consumers can distinguish
   *  "free/unreported" from "$0". */
  costUsd?: number
  /** Orchestration depth (0 = top-level). */
  depth?: number
  parentSessionId?: string
  /** Terminal rows only: why it ended. */
  endedReason?: SessionDescriptor["endedReason"]
}

/** Attention-worthiness rank for the board sort — the frozen order
 *  AWAITING > BLOCKED > STALE > ACTIVE > IDLE > COMMAND > ENDED. */
export function badgeRank(badge: SessionBoardBadge): number {
  switch (badge) {
    case "AWAITING":
      return 0
    case "BLOCKED":
      return 1
    case "STALE":
      return 2
    case "ACTIVE":
      return 3
    case "IDLE":
      return 4
    case "COMMAND":
      return 5
    case "ENDED":
      return 6
  }
}

function idleMsOf(row: BoardSession, nowMs: number): number | null {
  const tsStr = row.lastActivityAt ?? row.startedAt
  const ts = tsStr ? Date.parse(tsStr) : Number.NaN
  if (!Number.isFinite(ts)) return null
  return Math.max(0, nowMs - ts)
}

/** The frozen classification of ONE row — exported for table-driven tests
 *  of each rule in isolation. `classifySessions` is just this + sort. */
export function classifyOne(
  row: BoardSession,
  opts: { nowMs: number; staleAfterMs?: number },
): ClassifiedSession {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const idleMs = idleMsOf(row, opts.nowMs)
  const status = row.status ?? "running"
  const terminal = TERMINAL_STATUSES.has(status)

  let badge: SessionBoardBadge
  if (row.kind === "command") {
    badge = "COMMAND"
  } else if (terminal) {
    badge = "ENDED"
  } else if (row.blockedOn) {
    badge = "BLOCKED"
  } else if (row.awaitingInput === true || row.awaitingPermission === true) {
    badge = "AWAITING"
  } else if (row.busy === true) {
    // running|starting with a turn in flight. A `starting` row is busy
    // by construction of the spawn path, but `busy===true` is the gate.
    badge = "ACTIVE"
  } else {
    // Alive but not busy: STALE iff it is at reap-risk — past the age
    // threshold WITHOUT keepAlive, or interrupted mid-turn (it will
    // never wake on its own, whatever its age). keepAlive rows are
    // NEVER STALE: the session parked itself on purpose.
    const pastThreshold = idleMs !== null && idleMs > staleAfterMs
    const interrupted = row.interrupted === true
    badge = !row.keepAlive && (interrupted || pastThreshold) ? "STALE" : "IDLE"
  }

  const out: ClassifiedSession = {
    badge,
    id: row.id,
    label: row.name ?? row.id,
    kind: row.kind,
    status,
    idleMs,
    age: idleMs === null ? "?" : humaniseDelta(idleMs),
  }
  // Evidence fields: copied only when present, so --json stays clean and
  // `costUsd`'s absence (no usage source) is distinguishable from $0.
  if (row.busy !== undefined) out.busy = row.busy
  if (row.awaitingInput !== undefined) out.awaitingInput = row.awaitingInput
  if (row.awaitingPermission !== undefined)
    out.awaitingPermission = row.awaitingPermission
  if (row.blockedOn !== undefined) out.blockedOn = row.blockedOn
  if (row.keepAlive !== undefined) out.keepAlive = row.keepAlive
  if (row.interrupted !== undefined) out.interrupted = row.interrupted
  if (row.continuedFrom !== undefined) out.continuedFrom = row.continuedFrom
  if (row.model !== undefined) out.model = row.model
  if (row.costUsd !== undefined) out.costUsd = row.costUsd
  if (row.depth !== undefined) out.depth = row.depth
  if (row.parentSessionId !== undefined)
    out.parentSessionId = row.parentSessionId
  if (terminal && row.endedReason !== undefined)
    out.endedReason = row.endedReason
  return out
}

/** Classify every row and sort by attention-worthiness (stable within a
 *  badge: most-idle first for live badges, most-recent first for
 *  COMMAND/ENDED so a fresh log row isn't buried). PURE — no clock, no
 *  I/O; `nowMs` is injected. */
export function classifySessions(
  rows: readonly BoardSession[],
  opts: { nowMs?: number; staleAfterMs?: number } = {},
): ClassifiedSession[] {
  const nowMs = opts.nowMs ?? Date.now()
  return rows
    .map(row => classifyOne(row, { nowMs, staleAfterMs: opts.staleAfterMs }))
    .sort((a, b) => {
      const byRank = badgeRank(a.badge) - badgeRank(b.badge)
      if (byRank !== 0) return byRank
      const aIdle = a.idleMs ?? Number.POSITIVE_INFINITY
      const bIdle = b.idleMs ?? Number.POSITIVE_INFINITY
      if (a.badge === "COMMAND" || a.badge === "ENDED") return aIdle - bIdle
      return bIdle - aIdle
    })
}

/** The one-line summary header, e.g.
 *  `8 sessions — 2 active · 1 awaiting · 1 stale · 4 ended`.
 *  Non-zero buckets only, in badge-rank order. */
export function boardSummaryLine(rows: readonly ClassifiedSession[]): string {
  const counts = new Map<SessionBoardBadge, number>()
  for (const r of rows) counts.set(r.badge, (counts.get(r.badge) ?? 0) + 1)
  const order: SessionBoardBadge[] = [
    "AWAITING",
    "BLOCKED",
    "STALE",
    "ACTIVE",
    "IDLE",
    "COMMAND",
    "ENDED",
  ]
  const parts = order
    .map(b => {
      const n = counts.get(b) ?? 0
      return n > 0 ? `${n} ${b.toLowerCase()}` : null
    })
    .filter((p): p is string => p !== null)
  const noun = rows.length === 1 ? "session" : "sessions"
  const head = `${rows.length} ${noun}`
  return parts.length > 0 ? `${head} — ${parts.join(" · ")}` : head
}

const BADGE_COLOUR: Record<SessionBoardBadge, string> = {
  AWAITING: "\x1b[33m", // amber — needs a human
  BLOCKED: "\x1b[31m", // red — wedged on something
  STALE: "\x1b[35m", // magenta — reap-risk
  ACTIVE: "\x1b[32m", // green — in motion
  IDLE: "\x1b[2m", // dim — parked
  COMMAND: "\x1b[2m", // dim — log row
  ENDED: "\x1b[2m", // dim — done
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s
}

function depthCell(r: ClassifiedSession): string {
  if (r.depth === undefined && !r.parentSessionId) return "—"
  const d = r.depth !== undefined ? `d${r.depth}` : "d?"
  return r.parentSessionId ? `${d} ←${r.parentSessionId.slice(0, 8)}` : d
}

function costCell(r: ClassifiedSession): string {
  return r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : "—"
}

/** Render the classified board (summary header + sorted table). Pure —
 *  returns the string; the caller writes it. */
export function renderBoard(
  rows: readonly ClassifiedSession[],
  opts: { colour?: boolean } = {},
): string {
  const colour = opts.colour ?? false
  const lines: string[] = []
  lines.push(boardSummaryLine(rows))
  if (rows.length === 0) return lines.join("") + "\n"
  const w = {
    badge: Math.max(...rows.map(r => r.badge.length), 5),
    label: Math.min(Math.max(...rows.map(r => r.label.length), 4), 40),
    model: Math.max(...rows.map(r => (r.model?.length ?? 1)), 5),
    depth: Math.max(...rows.map(r => depthCell(r).length), 6),
    age: Math.max(...rows.map(r => r.age.length), 3),
    cost: Math.max(...rows.map(r => costCell(r).length), 4),
  }
  const header =
    pad("BADGE", w.badge) +
    "  " +
    pad("SESSION", w.label) +
    "  " +
    pad("MODEL", w.model) +
    "  " +
    pad("DEPTH", w.depth) +
    "  " +
    padL("AGE", w.age) +
    "  " +
    padL("COST", w.cost) +
    "  ENDED/NOTE"
  lines.push(`\x1b[2m${header}\x1b[0m`)
  for (const r of rows) {
    const note =
      r.badge === "ENDED"
        ? r.endedReason ?? ""
        : r.interrupted === true
          ? "interrupted"
          : r.keepAlive === true
            ? "keepAlive"
            : r.continuedFrom
              ? `↩ ${r.continuedFrom.slice(0, 12)}`
              : ""
    const badgeCell = colour
      ? `${BADGE_COLOUR[r.badge]}${pad(r.badge, w.badge)}\x1b[0m`
      : pad(r.badge, w.badge)
    lines.push(
      badgeCell +
        "  " +
        pad(r.label.slice(0, w.label), w.label) +
        "  " +
        pad(r.model ?? "—", w.model) +
        "  " +
        pad(depthCell(r), w.depth) +
        "  " +
        padL(r.age, w.age) +
        "  " +
        padL(costCell(r), w.cost) +
        "  " +
        note,
    )
  }
  return lines.join("\n") + "\n"
}

/** `agentproto sessions board` — parse flags, fetch, classify, render,
 *  optionally re-render every 2s on a TTY (`--watch`, `q` to quit). */
export async function runBoard(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      json: { type: "boolean" },
      watch: { type: "boolean" },
      all: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })
  if (values.json && values.watch) {
    process.stderr.write(
      "agentproto sessions board: --json can't be combined with --watch\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions board")
    return 2
  }
  const endpoint = report.found
  // `--all` opts into the command-execution LOG rows (kind:"command") —
  // the same rows `command_list` returns — via the daemon's existing
  // `?includeCommands=true` opt-in. Default view excludes them.
  const url = values.all
    ? `${endpoint.url}/sessions?includeCommands=true`
    : `${endpoint.url}/sessions`

  const colour = !values["no-color"] && process.stdout.isTTY === true

  const snapshot = async (): Promise<ClassifiedSession[]> => {
    const body = await httpGetJson<{ sessions?: BoardSession[] }>(url)
    const rows = Array.isArray(body?.sessions) ? body.sessions : []
    return classifySessions(rows)
  }
  const emit = async (): Promise<void> => {
    const classified = await snapshot()
    if (values.json) {
      process.stdout.write(JSON.stringify(classified, null, 2) + "\n")
    } else {
      process.stdout.write("\x1bc")
      process.stdout.write(renderBoard(classified, { colour }))
    }
  }

  if (!values.watch) {
    await emit()
    return 0
  }
  // --watch: cheap 2s re-render. On a non-TTY stdout fall back to a
  // single snapshot (piping a live loop into a pager is a mess), matching
  // the `sessions --watch` verb's non-TTY behaviour.
  if (!process.stdout.isTTY) {
    await emit()
    return 0
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")
  let stop = false
  const onKey = (key: string): void => {
    if (key === "q" || key === "\x03") {
      stop = true
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener("data", onKey)
    }
  }
  process.stdin.on("data", onKey)
  try {
    while (!stop) {
      try {
        await emit()
      } catch (err) {
        process.stdout.write(
          `\x1b[31mfetch error: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`,
        )
      }
      await new Promise<void>(res => setTimeout(res, 2000))
    }
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdin.removeListener("data", onKey)
  }
  return 0
}
