/**
 * Pure, server-side heuristics for a session's live "activity" line — the
 * SECONDARY, auto-regenerating label that answers "what is this session doing
 * RIGHT NOW?" so a glance at the sessions LIST is enough, without opening the
 * session and without disturbing its (frozen) `title`.
 *
 * Deliberately dependency-free — a `SessionState`, two pure summarisers, one
 * regenerate/guard helper — so it can be BOTH:
 *   - reused verbatim by `summarize_session` (agents-overview-app.ts re-exports
 *     `summarizeLines` / `deriveSessionState` from here), and
 *   - imported by the session store (sessions.ts) to stamp `activitySummary`
 *     onto the descriptor on turn-end, WITHOUT dragging the overview panel's
 *     HTML bundle or the MCP-app wiring into the hot session path.
 *
 * HEURISTIC, no LLM: `@agentproto/runtime` has no inference client (see the
 * agents-overview-app.ts header for why a `ModelLike.complete` call is too
 * heavy today). `regenerateActivitySummary` is the documented swap point —
 * replace its `summarizeLines`/`deriveSessionState` body with a
 * `ModelLike.complete({ system, prompt })` call to upgrade the line to a
 * semantic one; the trigger + `renamedByUser` guard contract and the
 * descriptor field it writes stay identical.
 */

import type { SessionDescriptor } from "./sessions.js"

// ── Heuristic summary (pure, server-side) ────────────────────────────────────

export type SessionState = "à traiter" | "au travail" | "en attente" | "terminé"

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
/** Chrome-only lines we never want as a summary (spinners, box-drawing,
 *  bare prompts, separators). */
const CHROME_RE = /^[\s>$#*✻✶✳·•.\-=_|~╭╰╮╯│─├┤┌┐└┘]+$/u
/** agentproto's OWN turn framing, flattened into the ring buffer alongside the
 *  agent's real output: the dim `── … ──` rules (prompt echo `── ▶ … ──`,
 *  `── turn-end (…) ──`, `── resuming … ──`) and the `[thought]` reasoning
 *  trace. None is a useful one-line answer to "what is the agent doing" — and
 *  the turn-end rule is always the LAST line by the time an activity summary is
 *  regenerated — so they're skipped alongside CHROME_RE, letting the summary
 *  land on the last real assistant/tool line instead of the framing. */
const FRAMING_RE = /^(?:──\s.*──|\[thought\](?:\s|$))/u

function strip(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "")
}

/**
 * Pick the last meaningful output line as a one-sentence summary.
 * Falls back to the session label/command when there's no usable output.
 */
export function summarizeLines(
  lines: readonly string[],
  desc: Pick<SessionDescriptor, "command" | "label" | "name">,
): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = strip(lines[i] ?? "").trim()
    if (t.length < 3) continue
    if (CHROME_RE.test(t)) continue
    if (FRAMING_RE.test(t)) continue
    return t.length > 160 ? `${t.slice(0, 157)}…` : t
  }
  return desc.label || desc.name || desc.command || "Aucune sortie pour le moment."
}

/**
 * Coarse state from lifecycle + recency. Heuristic, no LLM:
 *   terminé      — exited / killed / error
 *   à traiter    — alive and the agent flagged awaiting-input (your turn)
 *   au travail   — alive and produced output recently (< staleMs)
 *   en attente   — alive but idle (no recent output, not awaiting input)
 */
export function deriveSessionState(
  desc: Pick<SessionDescriptor, "status" | "awaitingInput" | "lastOutputAt">,
  nowMs: number,
  staleMs = 30_000,
): SessionState {
  if (desc.status === "exited" || desc.status === "killed" || desc.status === "error") {
    return "terminé"
  }
  if (desc.awaitingInput) return "à traiter"
  const last = desc.lastOutputAt ? Date.parse(desc.lastOutputAt) : Number.NaN
  if (!Number.isNaN(last) && nowMs - last < staleMs) return "au travail"
  return "en attente"
}

// ── Persisted activity summary (secondary dynamic label) ─────────────────────

/**
 * The secondary "activity" line persisted on the descriptor — distinct from the
 * frozen `title`. Regenerated on turn-end (throttled) from the heuristic
 * summariser above; rendered by the VSCode Sessions tree as the row's
 * description so a list glance says what each session is doing.
 */
export interface SessionActivitySummary {
  /** One-sentence heuristic summary — the last real assistant/tool line. */
  text: string
  /** Coarse lifecycle/recency state at the time it was regenerated. */
  state: SessionState
  /** ISO 8601 timestamp of when this line was last regenerated (drives the
   *  throttle + lets a client show its age). */
  at: string
}

/**
 * Minimum wall-clock gap between two activity regenerations for one session
 * (audit T2 #1: "≥1 turn AND ≥60s since last"). Cheap as the heuristic is,
 * a burst of fast turns shouldn't rewrite the line on every one; the FIRST
 * regeneration (no prior summary) is never throttled.
 */
export const ACTIVITY_MIN_INTERVAL_MS = 60_000

/**
 * Decide whether to regenerate a session's activity line, and if so produce the
 * new summary. Returns the summary to store, or `null` to leave the descriptor
 * untouched. Pure + injectable-`now` so the trigger and the guard are unit
 * testable without driving a whole session.
 *
 * Two invariants, both load-bearing (audit T2):
 *   1. GUARD — a session a HUMAN renamed (`renamedByUser`) has its activity
 *      semantics frozen: never regenerate for it (and `title` is never touched
 *      here regardless — this only ever writes `activitySummary`).
 *   2. THROTTLE — at most once per `minIntervalMs`; the first summary (no prior
 *      `activitySummary`) always generates.
 *
 * This is the documented LLM swap point: replace the `summarizeLines` /
 * `deriveSessionState` body with a model call and the trigger/guard contract
 * above stays identical.
 */
export function regenerateActivitySummary(
  desc: Pick<
    SessionDescriptor,
    | "renamedByUser"
    | "activitySummary"
    | "status"
    | "awaitingInput"
    | "lastOutputAt"
    | "command"
    | "label"
    | "name"
  >,
  lines: readonly string[],
  nowMs: number,
  minIntervalMs: number = ACTIVITY_MIN_INTERVAL_MS,
): SessionActivitySummary | null {
  // (1) A deliberate human rename freezes the activity line — never stomp it.
  if (desc.renamedByUser) return null
  // (2) Throttle to at most one regeneration per minIntervalMs.
  const prev = desc.activitySummary
  if (prev) {
    const prevAt = Date.parse(prev.at)
    if (!Number.isNaN(prevAt) && nowMs - prevAt < minIntervalMs) return null
  }
  return {
    text: summarizeLines(lines, desc),
    state: deriveSessionState(desc, nowMs),
    at: new Date(nowMs).toISOString(),
  }
}
