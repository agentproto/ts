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
