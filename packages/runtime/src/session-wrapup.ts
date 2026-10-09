/**
 * Session wrap-up plan (FIX-9A part 2) — deterministic, zero-LLM classifier
 * for "which idle sessions are safe to close". The runtime layer only: a
 * cheap judge agent for the ambiguous `judge` class is FIX-9B, not here.
 *
 * `planSessionWrapup` is pure over injected inputs, same discipline as
 * `runIdleReapPass`/`isReapable` (`idle-reaper.ts`) — no clock read, no I/O,
 * no registry access. The caller (the MCP tool, `session-tools.ts`) gathers
 * live signals (worktree status, transcript tails, RSS) and hands them in so
 * this module stays a pure function a test can pin exactly.
 *
 * Candidate universe mirrors `isReapable` (agent-cli only, `running` or
 * `starting`), with one deliberate divergence: `keepAlive` is no longer an
 * automatic exclusion. A `keepAlive` session that would otherwise close
 * downgrades to `judge` instead — a legitimately-parked supervisor still
 * deserves a second look, just not an autonomous close.
 *
 * `judge` is reserved for sessions that ARE idle-enough but ambiguous
 * (no merge/parent-ended signal, a pending tool call, or the keepAlive
 * downgrade above) — a barely-idle session never reaches a judge at all, it
 * stays `keep`. Sending every session that's merely idle for a minute to a
 * paid judge (FIX-9B) would be absurd.
 */

import type { SessionDescriptor } from "./sessions.js"

export type SessionWrapupClass = "close" | "stuck" | "judge" | "keep"

/** Per-session signals the caller gathers live and injects, keeping this
 *  module free of I/O. All optional/absent ⇒ "signal not observed". */
export interface SessionWrapupSignals {
  /** The session's cwd is a worktree whose integration is `merged`, or whose
   *  branch head is a merged PR — from the daemon's worktree-status engine
   *  (`computeWorktreeStatus` / `worktree_status`, `worktree-status.ts`). */
  worktreeMerged?: boolean
  /** The same worktree's PR is still `open` — a hand-off waiting on review or
   *  CI, which the steward reads as remaining work (never a reason to close). */
  worktreePrOpen?: boolean
  /** The session's parent (`parentSessionId`) has already ended. */
  parentEnded?: boolean
  /** Last ~600 chars of the session's last assistant message — same tail a
   *  derived outcome reads (`OUTCOME_TAIL_BYTES`, `session-outcome.ts`).
   *  Carried through for FIX-9B's judge; the deterministic classifier below
   *  never reads it. */
  lastAssistantTail?: string
  /** The session's last turn left a tool call outstanding (a background
   *  task, a parked permission) — never a `close` candidate mid-flight. */
  pendingToolCall?: boolean
  /** `status:"starting"`, no pid yet, older than 10 minutes — it never
   *  actually ran, so closing it drops no work. */
  stuckStarting?: boolean
}

export interface SessionWrapupEntry {
  sessionId: string
  label?: string
  /** Minutes since the session's last observed activity (or `startedAt`),
   *  rounded. The session's OWN idle span — not the threshold it was judged
   *  against (see `PlanSessionWrapupInput.idleMinutes` for that). */
  idleMinutes: number
  /** Copied from `SessionDescriptor.rssBytes` when the caller populated it
   *  (`session_list`'s `withMemory: true` / `processTreeRss`). Absent when
   *  the caller didn't gather it. */
  rssBytes?: number
  /** The session's provenance label (`SessionDescriptor.origin` — "cron:<id>",
   *  "gate", "chat-starter", "vscode", …), copied through so the session
   *  steward's origin policy can bound what it may close. Absent for a root
   *  spawned with no origin. */
  origin?: string
  /** The session's parent id (`SessionDescriptor.parentSessionId`), copied
   *  through: a session with a parent is an executor the steward may close,
   *  a root with no origin is human-launched and is not. */
  parentSessionId?: string
  class: SessionWrapupClass
  /** Short machine-stable reason codes explaining the classification —
   *  every guard/signal that fired, not just the first. */
  reasons: string[]
  /** The signals this entry was classified against, verbatim. */
  signals: SessionWrapupSignals
}

export interface PlanSessionWrapupInput {
  /** Every session the caller can see, agent-cli or not — a parent lookup
   *  by id must always resolve, same reasoning as `runIdleReapPass` reading
   *  `{ includeArchived: true }`. Only agent-cli, running/starting rows ever
   *  produce an entry. */
  sessions: readonly SessionDescriptor[]
  /** Injected clock (ms since epoch) — pure, deterministic classification. */
  nowMs: number
  /** Idle threshold in MINUTES a `close` candidate must clear. Default 20. */
  idleMinutes?: number
  /** Per-session live signals, keyed by session id. A session with no entry
   *  here is treated as every signal being unobserved (falsy). */
  signals: ReadonlyMap<string, SessionWrapupSignals>
  /** The id of the session/orchestrator requesting this plan — always kept,
   *  never a candidate for its own close (a session can't safely reason
   *  about closing itself mid-call). */
  callerSessionId?: string
}

const EMPTY_SIGNALS: SessionWrapupSignals = {}

/** Minutes since `lastActivityAt` (falling back to `startedAt`) to `nowMs`.
 *  0 (never negative) when the timestamp is missing/unparseable — an
 *  un-ageable row reads as "just active" rather than crashing the sort. */
function idleMinutesOf(desc: SessionDescriptor, nowMs: number): number {
  const tsStr = desc.lastActivityAt ?? desc.startedAt
  const ts = tsStr ? Date.parse(tsStr) : Number.NaN
  if (!Number.isFinite(ts)) return 0
  return Math.max(0, (nowMs - ts) / 60_000)
}

/**
 * Classify every in-scope session (agent-cli, `running` or `starting`) into
 * `close` / `stuck` / `judge` / `keep`. Pure: no clock read, no registry
 * call, no I/O — see the module doc for the guard/signal contract.
 */
export function planSessionWrapup(input: PlanSessionWrapupInput): SessionWrapupEntry[] {
  const { sessions, nowMs, signals, callerSessionId } = input
  const idleThresholdMinutes = input.idleMinutes ?? 20
  const byId = new Map<string, SessionDescriptor>(sessions.map(d => [d.id, d]))
  const entries: SessionWrapupEntry[] = []

  for (const desc of sessions) {
    if (desc.kind !== "agent-cli") continue
    if (desc.status !== "running" && desc.status !== "starting") continue

    const sig = signals.get(desc.id) ?? EMPTY_SIGNALS
    const idleMinutesActual = idleMinutesOf(desc, nowMs)
    const reasons: string[] = []
    let cls: SessionWrapupClass

    const parent = desc.parentSessionId ? byId.get(desc.parentSessionId) : undefined
    const parentAlive = parent !== undefined && (parent.status === "running" || parent.status === "starting")

    if (desc.busy === true) {
      cls = "keep"
      reasons.push("busy")
    } else if (desc.awaitingInput === true) {
      cls = "keep"
      reasons.push("awaitingInput")
    } else if (desc.awaitingPermission === true) {
      cls = "keep"
      reasons.push("awaitingPermission")
    } else if (desc.archived === true) {
      cls = "keep"
      reasons.push("archived")
    } else if (desc.pinned === true) {
      cls = "keep"
      reasons.push("pinned")
    } else if ((desc.childrenBusy ?? 0) > 0) {
      cls = "keep"
      reasons.push("childrenBusy")
    } else if (parentAlive) {
      cls = "keep"
      reasons.push("parentRunning")
    } else if (callerSessionId !== undefined && desc.id === callerSessionId) {
      cls = "keep"
      reasons.push("callerSession")
    } else if (sig.stuckStarting) {
      cls = "stuck"
      reasons.push("stuckStarting")
    } else if (desc.status !== "running") {
      // "starting", not yet 10min old (else stuckStarting above would have
      // fired) — too early to say anything, and a fresh session must not
      // reach a paid judge before `idleMinutes` could even apply (right
      // after a daemon restart every resumed session reads `starting`).
      cls = "keep"
      reasons.push("starting")
    } else if (idleMinutesActual < idleThresholdMinutes) {
      // Not idle long enough to say anything — this is the common case for
      // most running sessions, and it must stay `keep`: sending every
      // barely-idle session to a paid judge (FIX-9B) would be absurd.
      cls = "keep"
      reasons.push(`idle ${Math.round(idleMinutesActual)}m < ${idleThresholdMinutes}m`)
    } else {
      const mergeSignal = sig.worktreeMerged === true || sig.parentEnded === true
      reasons.push(`idle ${Math.round(idleMinutesActual)}m >= ${idleThresholdMinutes}m`)
      if (sig.worktreeMerged) reasons.push("worktreeMerged")
      if (sig.parentEnded) reasons.push("parentEnded")
      if (sig.pendingToolCall) reasons.push("pendingToolCall")

      if (mergeSignal && !sig.pendingToolCall) {
        if (desc.keepAlive === true) {
          cls = "judge"
          reasons.push("keepAlive downgrades close to judge")
        } else {
          cls = "close"
        }
      } else {
        cls = "judge"
      }
    }

    entries.push({
      sessionId: desc.id,
      ...(desc.label !== undefined ? { label: desc.label } : {}),
      idleMinutes: Math.round(idleMinutesActual),
      ...(desc.rssBytes !== undefined ? { rssBytes: desc.rssBytes } : {}),
      ...(desc.origin !== undefined ? { origin: desc.origin } : {}),
      ...(desc.parentSessionId !== undefined ? { parentSessionId: desc.parentSessionId } : {}),
      class: cls,
      reasons,
      signals: sig,
    })
  }

  return entries
}
