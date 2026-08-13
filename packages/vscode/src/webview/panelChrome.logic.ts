/**
 * Pure rendering helpers for the transcript panel's chrome (header icon,
 * detail-popover identity, context gauge) — no vscode import so they're
 * unit-testable, and each is SELF-CONTAINED (no module-scope references) so
 * `buildHtml` can inject it BY VALUE into the webview's inline script the same
 * way it injects the mention/drop helpers. Keep them that way: a helper that
 * reaches for an imported constant or a sibling function would stringify into a
 * reference the webview can't resolve.
 */

import type { Posture, SessionDescriptor } from "../client/types.js"
import type { PlanEntry } from "./conversation.js"

/**
 * The glyph a session's harness/adapter wears in the header title. There is no
 * per-adapter icon asset in the extension (media/session holds ACTIVITY icons
 * only), and the webview has no codicon font loaded, so this maps the adapter
 * slug to a single monochrome unicode mark — learned once, then read at a
 * glance. The `label` is the human name for the mark's `title=` tooltip, so the
 * mark is never a mystery. Matching is substring-based on a lowercased slug so
 * variants (`claude-code`, `claude`, `claude-code-gateway`) all resolve.
 */
export function harnessGlyph(slug?: string): { glyph: string; label: string } {
  const s = (slug ?? "").toLowerCase()
  if (!s) return { glyph: "◆", label: "harness" } // ◆ generic
  if (s.indexOf("claude") !== -1) return { glyph: "❋", label: slug as string } // ❋
  if (s.indexOf("codex") !== -1 || s.indexOf("openai") !== -1) return { glyph: "⬡", label: slug as string } // ⬡
  if (s.indexOf("hermes") !== -1) return { glyph: "☿", label: slug as string } // ☿
  if (s.indexOf("gemini") !== -1 || s.indexOf("google") !== -1) return { glyph: "♊", label: slug as string } // ♊
  return { glyph: "◆", label: slug as string } // ◆ any other harness
}

/**
 * The named identity the session's `access` axis is bound to — the wallet, not
 * the credential. Prefers the human `label` of the attached auth profile, then
 * its `profileRef`; falls back to the raw auth METHOD (`subscription`/`api-key`)
 * when no named profile is echoed. Never a secret — `SessionAccessProfileEcho`
 * carries no fingerprint (SPEC §3.6). `—` when the daemon reports neither.
 */
export function accessIdentity(
  session: Pick<SessionDescriptor, "accessProfile" | "auth"> | undefined,
): string {
  const profile = session ? session.accessProfile : undefined
  if (profile) return profile.label || profile.profileRef
  const auth = session ? session.auth : undefined
  if (auth && auth.mode) return auth.mode
  return "—" // —
}

/**
 * The session's posture, rendered as a single string — a `CanonicalPosture` is
 * already one, and a raw harness-mode posture (`{ harnessModeId }`, SPEC
 * §3.4a) renders as its mode id. `""` when absent, so the caller (the
 * composer chip) decides the empty-state label rather than this baking one in.
 */
export function postureLabel(posture: Posture | undefined): string {
  if (!posture) return ""
  if (typeof posture === "string") return posture
  return posture.harnessModeId
}

/**
 * A clear default posture label when the daemon reports none. Never "?" —
 * the chip should show something meaningful for the harness/kind instead of
 * an empty-looking placeholder. Pure and self-contained so it can be injected
 * into the webview alongside postureLabel.
 */
export function defaultPostureLabel(
  session: Pick<SessionDescriptor, "kind" | "adapterSlug" | "posture">,
): string {
  const explicit = postureLabel(session.posture)
  if (explicit) return explicit
  if (session.kind === "terminal") return "terminal"
  const slug = (session.adapterSlug ?? "").toLowerCase()
  if (slug.includes("claude")) return "default"
  if (slug.includes("hermes")) return "default"
  if (slug.includes("codex") || slug.includes("openai")) return "default"
  if (slug.includes("gemini") || slug.includes("google")) return "default"
  if (slug.includes("mastra")) return "default"
  if (slug.includes("opencode")) return "default"
  return "default"
}

/**
 * Context-window fill as a gauge model, or `null` when there's nothing to show
 * (missing/zero size). `ratio` is clamped to [0,1] — a runaway `used > size`
 * paints a full ring, not an overflowing one. `level` buckets the ring's color
 * (calm below 70%, warning by 90%) so the gauge is informative before you open
 * the popover for the raw counts.
 */
export function contextGauge(
  used: unknown,
  size: unknown,
): { ratio: number; pct: number; level: "low" | "mid" | "high" } | null {
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return null
  const ratio = Math.max(0, Math.min(1, used / size))
  const pct = Math.round(ratio * 100)
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low"
  return { ratio, pct, level }
}

/**
 * Short cost label for the merged metrics pill — two decimals (the full
 * precision moves to the pill's hover title). "—" when there's no figure yet.
 */
export function formatCostShort(costUsd: unknown): string {
  if (typeof costUsd !== "number" || !isFinite(costUsd)) return "—"
  return "$" + costUsd.toFixed(2)
}

/**
 * The context ring's colour band, following the session's contextContinuity
 * thresholds rather than fixed cutoffs: grey until `warnAtPct`, amber from
 * there, red from `compactAtPct` (where auto-compaction kicks in). Falls back
 * to 70/90 when a policy hasn't resolved yet. Pure — injected into the webview.
 */
export function contextRingLevel(
  pct: number,
  warnAtPct?: number,
  compactAtPct?: number,
): "grey" | "amber" | "red" {
  const warn = typeof warnAtPct === "number" ? warnAtPct : 70
  const compact = typeof compactAtPct === "number" ? compactAtPct : 90
  if (pct >= compact) return "red"
  if (pct >= warn) return "amber"
  return "grey"
}

/**
 * The visibility state for the title status dot (#session-visibility), with the
 * precedence awaiting > stalled > busy > delegating > parked > quiet — the same
 * order the tree's own `activityFor` uses for a session's OWN state (needs-you
 * before stalled before working), not the different "busy > awaiting" order
 * `subtreeBusiestActivity` uses to roll up a whole subtree. The previous
 * `busy > delegating > awaiting-input > parked > quiet` order borrowed that
 * subtree-rollup precedence for this single-session dot, so a busy session
 * masked its own more-urgent awaiting/stalled state (#601-adjacent).
 *
 * `stalled` reads `stalledSinceMs` — the daemon's turn-liveness watchdog flag
 * (stall-watchdog.ts), stamped once an agent-cli session goes silent mid-turn
 * past its threshold. That is the one "claims busy longer than expected"
 * surface (also consumed by the sessions webview's ⚠ badge); this dot is
 * self-contained (stringified into the webview via `.toString()`, per this
 * file's header) so it just reads the field rather than recomputing a
 * silence threshold locally. A starting session counts as busy (a turn is
 * coming). Pure — injected.
 */
export function titleStatusState(
  session: Pick<
    SessionDescriptor,
    "busy" | "status" | "childrenBusy" | "awaitingInput" | "watchers" | "stalledSinceMs"
  >,
): "busy" | "stalled" | "delegating" | "awaiting" | "parked" | "quiet" {
  if (session.awaitingInput) return "awaiting"
  if (session.busy) return session.stalledSinceMs !== undefined ? "stalled" : "busy"
  if (session.status === "starting") return "busy"
  if ((session.childrenBusy ?? 0) > 0) return "delegating"
  if ((session.watchers ?? 0) > 0) return "parked"
  return "quiet"
}

/** The minimalist plan block's projection (#conversation-chrome). Completed
 *  steps collapse to one "✓ N done" summary; failed stay individually visible;
 *  upcoming = the current (in_progress) step + the next few pending, with the
 *  remainder counted behind a "+N more". No strikethrough rows. Pure —
 *  injected into the webview and unit-tested. */
export interface PlanProjection {
  doneCount: number
  doneItems: PlanEntry[]
  failed: PlanEntry[]
  current: PlanEntry | undefined
  upcoming: PlanEntry[]
  moreCount: number
}

export function projectPlan(entries: PlanEntry[], upcomingLimit = 3): PlanProjection {
  const doneItems: PlanEntry[] = []
  const failed: PlanEntry[] = []
  const pending: PlanEntry[] = []
  let current: PlanEntry | undefined
  for (const e of entries || []) {
    if (e.status === "completed") doneItems.push(e)
    else if (e.status === "failed") failed.push(e)
    else if (e.status === "in_progress" && !current) current = e
    else pending.push(e)
  }
  const upcoming = pending.slice(0, upcomingLimit)
  return {
    doneCount: doneItems.length,
    doneItems,
    failed,
    current,
    upcoming,
    moreCount: pending.length - upcoming.length,
  }
}
