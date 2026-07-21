/**
 * Pure dispatch logic for the per-session config picker (`sessionConfig.ts`):
 * given a chosen chip + row (from `buildSessionConfigChips`), decide HOW to
 * apply it. No vscode/daemon import — unit-testable.
 *
 * Three outcomes (SPEC §6 rule 1 + §4.5):
 *  - `addProfile` — the access chip's "+ add profile" row: open the auth flow.
 *  - `live`      — a live chip (model/effort/posture) on a non-restart row:
 *                  call the bound live verb; if the daemon answers
 *                  `applied:false, reason:"requires-restart"`, fall back to a
 *                  `session_restart` with the same override.
 *  - `restart`   — a restart-only chip (route/access/contextProfile) OR a
 *                  live chip's restart-tagged row (the model↔route trap, an
 *                  advisory posture): apply via `session_restart` override.
 */

import type { ConfigAxis, ConfigChip, ConfigChipRow, ConfigVerb } from "./sessionConfig.logic.js"

/** The `session_restart` override object for one axis + value (SPEC §4.3). */
export type RestartOverride =
  | { model: string }
  | { effort: string }
  | { route: { gateway: string } }
  | { access: { profileRef: string } }
  | { posture: string | { harnessModeId: string } }
  | { contextProfile: string }

/** The five canonical postures — a value outside this set is a raw harness mode
 *  id, which `session_restart` takes as `{ harnessModeId }` rather than a bare
 *  string (session-tools.ts posture union). */
const CANONICAL_POSTURES = new Set(["default", "plan", "accept-edits", "bypass", "read-only"])

/** Build the restart override for an axis + row value. Returns undefined for an
 *  axis that carries no restart override (there is none today, but keeps the
 *  mapping total + future-proof). */
export function restartOverrideFor(axis: ConfigAxis, value: string): RestartOverride | undefined {
  switch (axis) {
    case "model":
      return { model: value }
    case "effort":
      return { effort: value }
    case "route":
      return { route: { gateway: value } }
    case "access":
      return { access: { profileRef: value } }
    case "posture":
      return { posture: CANONICAL_POSTURES.has(value) ? value : { harnessModeId: value } }
    case "contextProfile":
      return { contextProfile: value }
    default:
      return undefined
  }
}

export type ChipDispatch =
  | { kind: "addProfile" }
  | { kind: "noop" }
  | { kind: "live"; verb: ConfigVerb; axis: ConfigAxis; value: string; override: RestartOverride }
  | { kind: "restart"; axis: ConfigAxis; value: string; override: RestartOverride }

/**
 * Decide how to apply a picked (chip, row). A row already selected as current
 * is a no-op. The add-profile row short-circuits. A restart-only chip or a
 * restart-tagged row routes through `session_restart`; otherwise the live verb
 * runs (with a `requires-restart` fallback the caller handles via
 * {@link liveFallbackToRestart}).
 */
export function planChipDispatch(chip: ConfigChip, row: ConfigChipRow): ChipDispatch {
  if (row.addProfile) return { kind: "addProfile" }
  if (row.current) return { kind: "noop" }
  const override = restartOverrideFor(chip.axis, row.value)
  if (!override) return { kind: "noop" }
  if (chip.restart || row.restartRequired) {
    return { kind: "restart", axis: chip.axis, value: row.value, override }
  }
  return { kind: "live", verb: chip.verb, axis: chip.axis, value: row.value, override }
}

/** A live-verb result signals a restart fallback when it did not apply and the
 *  reason is exactly `requires-restart` (session.ts contract). Any other
 *  `applied:false` (e.g. `not-supported`) is a soft warning, not a restart. */
export function liveFallbackToRestart(result: { applied?: boolean; reason?: string }): boolean {
  return result.applied === false && result.reason === "requires-restart"
}
