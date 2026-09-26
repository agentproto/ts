/**
 * Pure view-model helpers for a session's derived OUTCOME (Level 1) — what an
 * ended session produced, as recorded by the daemon on `SessionDescriptor.outcome`
 * (see the runtime's `session-outcome.ts`). Two consumers:
 *
 *   - the transcript panel's outcome card ({@link outcomeCardFor}), injected BY
 *     VALUE into the webview script like the panelChrome helpers — so it is
 *     SELF-CONTAINED: no module-scope references, no calls to siblings;
 *   - the sessions list row's one-line hint ({@link outcomeHintFor}).
 *
 * A session without an outcome (still running, or older than the feature)
 * yields `null`/`undefined` — the caller renders nothing new.
 */

import type { SessionDescriptor, SessionOutcome, SessionSummary } from "../client/types.js"

export type OutcomeTone = "ok" | "warn" | "error" | "muted"

export interface OutcomeCardItem {
  /** Visible text. */
  label: string
  /** Hover text — the full ref. */
  title: string
  /** `external` — an http(s) URL to open in the browser; `session` — a session
   *  id to open in its transcript; absent — plain text (no viewer for it). */
  open?: "external" | "session"
  target?: string
}

export interface OutcomeCard {
  tone: OutcomeTone
  /** "killed · mid-turn", "idle-reaped", "exited · code 1", … */
  termination: string
  /** "2h 5m" — absent when the daemon recorded no duration. */
  duration?: string
  /** "$0.42" — absent when unknown. */
  cost?: string
  /** "12.3k in · 4.1k out" — absent when unknown. */
  tokens?: string
  /** True for `status: "empty"`: the session said nothing and left nothing. */
  empty: boolean
  summary?: string
  /** Long enough to be worth a collapse/expand toggle (~3 lines). */
  collapsible: boolean
  artifacts: OutcomeCardItem[]
  links: OutcomeCardItem[]
}

/**
 * The outcome card for an ended session, or `null` when it has no outcome.
 * Self-contained (injected by value into the transcript webview).
 */
export function outcomeCardFor(session: Pick<SessionDescriptor, "outcome"> | null | undefined): OutcomeCard | null {
  // The compact list projection (no termination) is not enough for a card.
  const o = (session ? session.outcome : undefined) as SessionOutcome | undefined
  if (!o || !o.termination) return null
  const t = o.termination
  const reasons: Record<string, string> = {
    "idle-reaped": "idle-reaped",
    "daemon-restart": "killed · daemon restart",
    crashed: "crashed",
  }
  let termination: string
  if (t.reason && reasons[t.reason]) termination = reasons[t.reason] as string
  else if (t.reason) termination = t.status + " · " + t.reason.replace(/-/g, " ")
  else termination = t.status
  if (t.midTurn && termination.indexOf("mid-turn") === -1) termination += " · mid-turn"
  if (t.status === "exited" && typeof t.exitCode === "number" && t.exitCode !== 0) termination += " · code " + t.exitCode

  const empty = o.status === "empty"
  let tone: OutcomeTone
  if (t.status === "error" || t.reason === "crashed" || (t.status === "exited" && typeof t.exitCode === "number" && t.exitCode !== 0)) tone = "error"
  else if (empty) tone = "muted"
  else if (t.status === "killed" && t.reason !== "idle-reaped") tone = "warn"
  else tone = "ok"

  const c = o.cost || {}
  let duration: string | undefined
  if (typeof c.durationMs === "number" && c.durationMs >= 0) {
    const s = Math.floor(c.durationMs / 1000)
    if (s < 60) duration = s + "s"
    else if (s < 3600) duration = Math.floor(s / 60) + "m" + (s % 60 ? " " + (s % 60) + "s" : "")
    else if (s < 86400) duration = Math.floor(s / 3600) + "h" + (Math.floor(s / 60) % 60 ? " " + (Math.floor(s / 60) % 60) + "m" : "")
    else duration = Math.floor(s / 86400) + "d" + (Math.floor(s / 3600) % 24 ? " " + (Math.floor(s / 3600) % 24) + "h" : "")
  }
  const cost = typeof c.usd === "number" && isFinite(c.usd) ? "$" + c.usd.toFixed(2) : undefined
  const k = (n: number): string =>
    n >= 1_000_000
      ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
      : n >= 1000
        ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k"
        : String(n)
  const tokParts: string[] = []
  if (typeof c.tokensIn === "number") tokParts.push(k(c.tokensIn) + " in")
  if (typeof c.tokensOut === "number") tokParts.push(k(c.tokensOut) + " out")
  const tokens = tokParts.length > 0 ? tokParts.join(" · ") : undefined

  const isWeb = (ref: string): boolean => /^https?:\/\//i.test(ref)
  const artifacts: OutcomeCardItem[] = (o.artifacts || []).map(a => {
    if (a.type === "pr") {
      const m = /\/pull\/(\d+)/.exec(a.ref)
      const label = "PR " + (a.title || (m ? "#" + m[1] : a.ref))
      return isWeb(a.ref) ? { label, title: a.ref, open: "external", target: a.ref } : { label, title: a.ref }
    }
    if (a.type === "commit") return { label: "commit " + (a.title || a.ref.slice(0, 7)), title: a.ref }
    return isWeb(a.ref)
      ? { label: a.title || a.ref, title: a.ref, open: "external", target: a.ref }
      : { label: a.title || a.ref, title: a.ref }
  })
  const links: OutcomeCardItem[] = (o.links || []).map(l => {
    if (l.rel === "run") return { label: (l.title ? "wf:" + l.title : "workflow") + " → " + l.ref, title: "workflow run " + l.ref }
    if (l.rel === "parent") return { label: "parent " + l.ref, title: "Open the parent session", open: "session", target: l.ref }
    return { label: l.rel + " " + (l.title || l.ref), title: l.ref }
  })

  const summary = o.summary && o.summary.trim() ? o.summary.trim() : undefined
  return {
    tone,
    termination,
    ...(duration ? { duration } : {}),
    ...(cost ? { cost } : {}),
    ...(tokens ? { tokens } : {}),
    empty,
    ...(summary ? { summary } : {}),
    collapsible: summary ? summary.length > 240 || summary.split("\n").length > 3 : false,
    artifacts,
    links,
  }
}

/** Max characters of the list row's outcome hint. */
export const OUTCOME_HINT_MAX = 80

/**
 * The sessions list row's one-line outcome hint for an ENDED session: the
 * first {@link OUTCOME_HINT_MAX} chars of the summary, or "no output" (muted)
 * for an empty outcome. `undefined` for a live session or one without an
 * outcome — the row keeps its usual activity line. Works on the full outcome
 * or the daemon's compact `{ status, summary }` list projection alike.
 */
export function outcomeHintFor(
  session: Pick<SessionSummary, "status" | "outcome">,
): { text: string; muted: boolean } | undefined {
  const o = session.outcome
  if (!o) return undefined
  if (session.status !== "exited" && session.status !== "killed" && session.status !== "error") return undefined
  if (o.status === "empty") return { text: "no output", muted: true }
  const flat = (o.summary ?? "").replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return { text: flat.length > OUTCOME_HINT_MAX ? `${flat.slice(0, OUTCOME_HINT_MAX - 1)}…` : flat, muted: false }
}
