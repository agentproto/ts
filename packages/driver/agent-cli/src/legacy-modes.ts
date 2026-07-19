/**
 * Legacy AIP-45 mode-id classification — the SINGLE SOURCE for recognizing the
 * gateway (route) and permission (posture) ids that used to be declared as
 * `modes[]` entries before the SPEC §3.4a route/posture extraction.
 *
 * Those entries are now deleted from the adapter manifests: route is derived
 * from the model catalog's `@route` route-identity and posture comes from the
 * harness's own ACP mode registry (`SessionModeState.availableModes`) plus the
 * canonical-posture layer (step 2c). But a caller may STILL pass one of the old
 * ids as `config.mode` — a persisted OPERATOR.md `runtime.config.mode`, a
 * `defaults.adapters.<slug>` binding, or an in-flight request written against
 * the pre-migration manifest. Both the compose path (`composeSpawn`) and the
 * daemon-boundary shim (`@agentproto/runtime`'s `decomposeMode`) therefore need
 * to recognize the legacy vocabulary. `@agentproto/runtime` imports this module
 * rather than re-hardcoding the list, so the id→axis classification stays
 * single-sourced across the driver/runtime boundary (runtime → driver only; the
 * driver stays lean, never depending back on the runtime).
 *
 * This module classifies onto the AXIS only (`route`/`posture`/`context`); the
 * canonical-posture value mapping (`bypass-permissions` → `bypass`, …) is a
 * daemon concept and lives in `@agentproto/runtime`, keyed by
 * {@link LEGACY_POSTURE_MODE_IDS}.
 */

/** Gateway-preset ids that were declared as `kind:"route"` modes. */
export const LEGACY_GATEWAY_MODE_IDS: ReadonlySet<string> = new Set([
  "moonshot",
  "openrouter",
  "requesty",
  "deepseek",
])

/**
 * Permission-profile ids that were declared as `kind:"posture"` modes across
 * the claude-code / codex / opencode adapters (the superset over adapters —
 * some ids are another adapter's vocabulary: codex's `full-access`, opencode's
 * `build`).
 */
export const LEGACY_POSTURE_MODE_IDS: ReadonlySet<string> = new Set([
  "default",
  "plan",
  "accept-edits",
  "bypass-permissions",
  "read-only",
  "full-access",
  "build",
])

/**
 * Classify a legacy mode id onto its orthogonal axis. Gateway ids ⇒ `"route"`,
 * known permission ids ⇒ `"posture"`, everything else ⇒ `"context"` — the
 * least-privilege default, so a truly-unknown id never silently grants a
 * posture or reroutes billing (SPEC R4).
 */
export function inferLegacyModeKind(
  modeId: string,
): "posture" | "route" | "context" {
  if (LEGACY_GATEWAY_MODE_IDS.has(modeId)) return "route"
  if (LEGACY_POSTURE_MODE_IDS.has(modeId)) return "posture"
  return "context"
}

/**
 * True when `modeId` is a KNOWN legacy route-or-posture id that used to be a
 * `modes[]` entry but was extracted (SPEC §3.4a) — i.e. it classifies as
 * `route` or `posture`, not `context` and not a genuinely-unknown id.
 * `composeSpawn` degrades such an id to a soft no-op (no env/argv patch: route
 * now resolves from the catalog, posture from the ACP registry / canonical
 * layer) instead of throwing `unknown_mode`; a truly-unknown id — for which
 * this returns `false` — still throws.
 */
export function isLegacyExtractedModeId(modeId: string): boolean {
  return (
    LEGACY_GATEWAY_MODE_IDS.has(modeId) || LEGACY_POSTURE_MODE_IDS.has(modeId)
  )
}
