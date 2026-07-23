/**
 * Pure descriptor→preset transform behind `agentproto.saveFavorite`. Kept
 * vscode-free so it's directly unit-testable (same split as spawn.logic.ts).
 *
 * A favorite is the running session's spawn axes lifted into a reusable
 * `UserPreset`: adapter, model, route, the *reference* to the auth profile
 * (never the credential — the descriptor only carries a non-secret
 * `accessProfile.profileRef`), the effort/context axes, the pinned `cwd`, and
 * "mode". Mode is folded into the preset's `posture` axis: the descriptor's
 * AIP-45 `mode` becomes `{ harnessModeId }` when no explicit posture is set —
 * the same shape the preset schema already accepts (user-presets.ts) — so a
 * favorite re-spawns in the mode you captured it from.
 */

import type { UserPreset } from "../client/types.js"
import type { SessionDescriptor } from "../client/types.js"

/**
 * Slugify a favorite's label into a stable machine-local id matching the
 * daemon's `^[a-z0-9][a-z0-9-]*$` preset-id rule: lowercase, collapse every
 * run of non-alphanumerics to a single `-`, and strip leading/trailing `-`
 * (a leading digit/letter is required). Returns `undefined` when nothing
 * usable survives (e.g. a label of only punctuation) so the caller can ask
 * again rather than POST an id the daemon will reject.
 */
export function slugifyPresetId(label: string): string | undefined {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : undefined
}

/**
 * Build a UserPreset from a live session descriptor + a chosen id/label.
 * Only sets an axis when the descriptor actually carries it, so a favorite
 * never pins an empty string the daemon would treat as an explicit override.
 */
export function presetFromSession(
  session: SessionDescriptor,
  choice: { id: string; label: string },
): UserPreset {
  const preset: UserPreset = { id: choice.id, label: choice.label }
  if (session.adapterSlug) preset.adapter = session.adapterSlug
  if (session.model) preset.model = session.model
  if (session.route) preset.route = session.route
  if (session.accessProfile?.profileRef) {
    preset.access = { profileRef: session.accessProfile.profileRef }
  }
  // Mode → posture.harnessModeId, unless a posture is explicitly echoed.
  if (session.posture !== undefined) preset.posture = session.posture
  else if (session.mode) preset.posture = { harnessModeId: session.mode }
  if (session.effort) preset.effort = session.effort
  if (session.contextProfile) preset.contextProfile = session.contextProfile
  if (session.cwd) preset.cwd = session.cwd
  return preset
}
