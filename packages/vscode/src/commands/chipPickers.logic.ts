/**
 * Pure decision logic for the composer chip pickers (chip-pickers WP) — NO
 * vscode import, so the contracts are unit-testable and the UI wiring
 * (chipPickers.ts) stays a thin shell around them.
 *
 * The bottom chip bar exposes six config axes. They split two ways:
 *   - IN-PLACE (model / posture / effort): switch a live session with no
 *     restart, via the non-fatal POST /sessions/:id/{model,posture,effort}
 *     routes ({applied:false, reason} on rejection → revert + toast).
 *   - RESTART-BOUND (wallet / harness / route): can't change under a live
 *     session, so switching drives POST /sessions/:id/restart with the override.
 *     The conversation carries over (a restart RESUMES — never a blank session);
 *     the confirm makes that promise, and the resumeVia badge reports what
 *     actually carried afterward.
 */

/** The six switchable config axes surfaced as composer chips. */
export type ChipAxis = "model" | "posture" | "effort" | "wallet" | "harness" | "route"

export type ChipSwitchKind = "in-place" | "restart-bound"

const AXIS_KIND: Readonly<Record<ChipAxis, ChipSwitchKind>> = {
  model: "in-place",
  posture: "in-place",
  effort: "in-place",
  wallet: "restart-bound",
  harness: "restart-bound",
  route: "restart-bound",
}

/** Whether an axis switches live or requires the restart-with-override flow. */
export function chipSwitchKind(axis: ChipAxis): ChipSwitchKind {
  return AXIS_KIND[axis]
}

const AXIS_NOUN: Readonly<Record<ChipAxis, string>> = {
  model: "model",
  posture: "mode",
  effort: "effort",
  wallet: "wallet",
  harness: "harness",
  route: "route",
}

/**
 * The confirm shown before a restart-bound switch. Names the axis and the
 * target, and makes the carry-over promise explicit so a restart never reads as
 * "start over". Returns undefined for an in-place axis (no confirm — it just
 * switches).
 */
export function restartConfirmMessage(axis: ChipAxis, to: string): string | undefined {
  if (chipSwitchKind(axis) === "in-place") return undefined
  return (
    `Switching ${AXIS_NOUN[axis]} to "${to}" restarts the session — ` +
    `the conversation carries over. Continue?`
  )
}

export interface ResumeBadge {
  /** Short label for the post-restart badge. */
  label: string
  /** "full" when the whole conversation resumed, "summary" when it fell back to
   *  a compacted summary, "none" when no continuity was established. */
  fidelity: "full" | "summary" | "none"
}

/**
 * Map a restart result's `resumeVia` / `resumeFallback` onto the badge shown
 * after a restart-switch. `resumeFallback` (the daemon fell back to a summary
 * because a full resume wasn't available) wins; an empty `resumeVia` means no
 * continuity was established at all.
 */
export function resumeBadge(resumeVia: string | undefined, resumeFallback?: boolean): ResumeBadge {
  if (resumeFallback) return { label: "resumed: summary", fidelity: "summary" }
  if (!resumeVia || resumeVia.trim() === "") return { label: "resumed: no context", fidelity: "none" }
  return { label: "resumed: full context", fidelity: "full" }
}

/**
 * The toast after an in-place switch attempt. `applied` → no toast (the chip
 * already updated optimistically). Not applied → the revert message naming the
 * daemon's reason, so a rejected model/effort/posture doesn't silently snap
 * back with no explanation.
 */
export function inPlaceSwitchToast(
  axis: ChipAxis,
  result: { applied: boolean; reason?: string },
): string | undefined {
  if (result.applied) return undefined
  const why = result.reason ? ` (${result.reason})` : ""
  return `Couldn't switch ${AXIS_NOUN[axis]}${why} — reverted.`
}
