/**
 * DASHBOARD-level session-presence triage — "which of my many sessions in the
 * LIST needs a glance?" — as one shared, pure classifier consumed identically
 * by the CLI sessions table and the VS Code sessions tree / webview panel.
 *
 * This is deliberately COARSER than `activityFor` (the vscode package's
 * 8-state per-session classifier, `sessionsTree.logic.ts`): that one answers
 * the fine-grained "what IS this one session" question for a transcript chip
 * / status bar / detail row, with its own stall detection and `pendingBgTasks`
 * conventions. This answers the list-level presence question with a four-state
 * vocabulary, and resolves the divergence bug where the CLI and VS Code each
 * derived their own (already-inconsistent) reading of the same `SessionDescriptor`.
 *
 * The four states map onto "does anything want my attention right now, and if
 * so what kind":
 *   running   — a turn is actively turning, OR the session just finished one
 *               (still inside the grace window). Peers with `tending` at the
 *               top of any presence-urgency sort. Do not touch.
 *   tending   — not running, not in grace, but has active sub-agents
 *               (`childrenBusy`) or background tasks still pending
 *               (`pendingBgTasks`) — it's busy THROUGH others. Peers with
 *               `running`, not a step below it. Half-filled mark. Watch it,
 *               don't prompt it.
 *   attention — needs the human: awaiting input or a held permission
 *               (`awaitingInput`/`awaitingPermission`), or its own last turn
 *               failed in-band (`lastTurnErroredAt`), or it ended badly
 *               (error / non-zero exit). Amber. Look at me.
 *   quiet     — none of the above. Grey. Leave alone.
 *
 * The classifier is PURE: it never reads config/fs/timers. The caller resolves
 * `attentionDelaySec` (via `resolveAttentionDelaySec`) and passes it in, and
 * passes a `now` so tests (and a repainting UI) can control time. State is
 * re-derived fresh on every call — the grace window is measured from
 * `lastActivityAt`, so an event arriving resets it automatically; there is no
 * stored timer state to keep in sync.
 */

import { loadConfig } from "./config.js"

/** Env override for the grace window (seconds). Highest-priority source,
 *  ahead of the `sessions.attentionDelaySec` config field — see
 *  `resolveAttentionDelaySec`. */
export const ATTENTION_DELAY_ENV = "AGENTPROTO_SESSIONS_ATTENTION_DELAY_SEC"

/** The default grace window (seconds) when nothing is configured. */
export const DEFAULT_ATTENTION_DELAY_SEC = 60

/**
 * The four presence states, in display-priority order. `running` and `tending`
 * are PEERS at the top (both are "in motion, leave alone"); `attention` is the
 * only one that says "a human should look"; `quiet` needs nothing.
 */
export type SessionPresence = "running" | "tending" | "attention" | "quiet"

/**
 * Structural input — the subset of `SessionDescriptor` (runtime) / the
 * vscode client type that the classifier reads. Kept as a handful of optional
 * fields (not a hard `Pick<SessionDescriptor, …>`) so both packages' slightly
 * different descriptor shapes satisfy it without a cast.
 */
export interface SessionPresenceInput {
  status?: string
  /** A turn is actually in flight right now. */
  busy?: boolean
  /** Sub-agents (children/grandchildren) currently mid-turn. */
  childrenBusy?: number
  /** Background tool starts from the last turn still pending. */
  pendingBgTasks?: number
  /** Blocked on the human for a reply. */
  awaitingInput?: boolean
  /** Blocked on the human for a permission decision. */
  awaitingPermission?: boolean
  /** ISO 8601 of the last observed activity — the "something just happened"
   *  timestamp that anchors the grace window. Falls back to `lastOutputAt`. */
  lastActivityAt?: string
  lastOutputAt?: string
  /** The adapter's own last turn failed in-band — needs a look, not a
   *  re-prompt on faith. */
  lastTurnErroredAt?: string
  /** How the session ended, when it has. */
  exitCode?: number
}

export interface PresenceOptions {
  /** Epoch ms serving as "now". Defaults to `Date.now()`. Pass an explicit
   *  value when you need deterministic, time-controlled classification. */
  now?: number
  /** The grace window to use — resolved by the caller via
   *  `resolveAttentionDelaySec`. Defaults to {@link DEFAULT_ATTENTION_DELAY_SEC}. */
  attentionDelaySec?: number
}

const TERMINAL_STATUSES = new Set(["exited", "killed", "error"])

/** Whether the session's most recent activity sits within the grace window of
 *  `now` — i.e. it is still "just did something". `lastActivityAt` is the
 *  truthiest "something happened" timestamp (it resets on ANY event, which is
 *  exactly the "any new event resets the grace timer" contract); `lastOutputAt`
 *  is the fallback for a descriptor predating it. Absent → false. */
export function inAttentionGrace(
  s: Pick<SessionPresenceInput, "lastActivityAt" | "lastOutputAt">,
  opts?: PresenceOptions,
): boolean {
  const delaySec = opts?.attentionDelaySec ?? DEFAULT_ATTENTION_DELAY_SEC
  if (delaySec <= 0) return false
  const now = opts?.now ?? Date.now()
  const iso = s.lastActivityAt ?? s.lastOutputAt
  if (!iso) return false
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return false
  return now - at < delaySec * 1000
}

/**
 * Classify a session onto the four-state presence axis. Most-urgent-first
 * precedence: terminal error > terminal done > the human is needed
 * (`awaitingInput`/`awaitingPermission`/`lastTurnErroredAt`) > a turn is in
 * flight > still inside the grace window > tending (children / bg) > quiet.
 *
 * Terminal sessions are folded onto the same four states rather than left
 * unclassified, so every consumer can render a total badge from this one
 * function: one that ended badly (`status:"error"` or a non-zero exit) reads
 * `attention` — a crashed/failed row still deserves a glance — while a clean
 * or stopped one reads `quiet`.
 */
export function presenceFor(
  s: SessionPresenceInput,
  opts?: PresenceOptions,
): SessionPresence {
  if (TERMINAL_STATUSES.has(s.status ?? "")) {
    return isTerminalError(s) ? "attention" : "quiet"
  }
  // Blocked on the human is the loudest live signal — it is the whole reason
  // the dashboard has an "attention" lane at all. `lastTurnErroredAt` (the
  // adapter's own in-band failure, process alive) folds in here: the last thing
  // it did needs a look, not a re-prompt on faith.
  if (s.awaitingInput === true || s.awaitingPermission === true || s.lastTurnErroredAt) {
    return "attention"
  }
  // A turn actually in flight. Also covers `starting` (booting is in motion,
  // and the session isn't quiet simply because no turn has landed yet).
  if (s.busy === true || s.status === "starting") return "running"
  // Just finished — still inside the grace window, so the list doesn't dump a
  // session into "quiet" the instant its turn ends. Re-derived from
  // `lastActivityAt` every call, so a new event resets the timer by moving the
  // anchor forward.
  if (inAttentionGrace(s, opts)) return "running"
  // Not busy, not in grace, but busy THROUGH others (active sub-agents or
  // background tasks still pending) — "tending", a peer of running, not a
  // step below it.
  if ((s.childrenBusy ?? 0) > 0 || (s.pendingBgTasks ?? 0) > 0) return "tending"
  return "quiet"
}

/** Terminal-error detection shared by the classifier — `status:"error"` or a
 *  non-zero `exitCode` (a non-zero exit on a `killed` row is how SIGTERM reads,
 *  so exit code alone is NOT enough; status "killed" already maps to quiet). */
function isTerminalError(s: SessionPresenceInput): boolean {
  if (s.status === "error") return true
  return s.status === "exited" && typeof s.exitCode === "number" && s.exitCode > 0
}

/**
 * Resolve the effective grace window: env > config field > default. Mirrors
 * `loadWorktreeIsolation`'s precedence and "never throws / unreadable config
 * falls through to the default" discipline (`worktree-isolation.ts`).
 */
export async function resolveAttentionDelaySec(
  loadCfg: () => Promise<{ sessions?: { attentionDelaySec?: number } }> = loadConfig,
): Promise<number> {
  const fromEnv = Number(process.env[ATTENTION_DELAY_ENV])
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv
  try {
    const cfg = await loadCfg()
    const fromCfg = cfg.sessions?.attentionDelaySec
    if (typeof fromCfg === "number" && Number.isFinite(fromCfg) && fromCfg >= 0) {
      return fromCfg
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_ATTENTION_DELAY_SEC
}