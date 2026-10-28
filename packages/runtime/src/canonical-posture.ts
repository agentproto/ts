/**
 * Canonical-posture layer (SPEC §3.4a, build step 2c, out-of-repo design doc
 * `agentproto-session-config-axes/SPEC.md`). Pure: a map + preambles + a
 * resolution helper, no I/O, no daemon wiring. It is the piece that makes the
 * agentproto-canonical posture vocabulary (`CanonicalPosture` from
 * `./session-config.js`) portable across harnesses:
 *
 *   1. **Native enforcement.** A canonical posture is resolved to a *harness*
 *      `SessionModeId` when the session's advertised `availableModes`
 *      (`SessionModeState.availableModes`, surfaced read-only by the ACP
 *      capability layer landed in #482, `packages/acp/src/client/index.ts`) has
 *      an equivalent. That mode is switched live via `setSessionMode` (step 5)
 *      or applied on restart (step 6) — a real permission boundary.
 *   2. **Prompt-injection fallback.** When no advertised mode matches, the
 *      posture is honoured as an injected system-prompt PREAMBLE — advisory,
 *      NOT a permission boundary (SPEC risk Rw). This module returns the
 *      preamble text; steps 5/6 ride it onto the system prompt at spawn.
 *      Independently, the driver forwards the canonical posture to the adapter
 *      at spawn/restart (`AgentCliStartOptions.posture`), and some adapters
 *      enforce it there even with no advertised mode — claude-code via its
 *      isolated `permissions.defaultMode`, opencode via a per-session
 *      `permission` config block (`@agentproto/driver-agent-cli`'s
 *      `opencode-permission.ts`). For those the preamble is then accurate
 *      context riding alongside a real boundary, not the only one.
 *
 * This module deliberately does NOT implement the live-posture verb (step 5) or
 * the posture restart-override (step 6) — it only tells them WHICH of the two
 * apply-paths a given (posture × session) resolves to, and supplies the
 * preamble for the fallback path.
 *
 * Read-surface dependency: `availableModes` comes from the #482 ACP capability
 * read surface (`AcpClientSession.availableModes` →
 * `AgentCliRuntimeSession.availableModes`) — this module consumes it, never
 * reimplements it.
 */

import type { SessionMode } from "@agentproto/acp/client"
import type { CanonicalPosture, Posture } from "./session-config.js"

export type { SessionMode }

/**
 * Per-posture system-prompt preamble — the prompt-injection fallback applied
 * when a canonical posture has NO native advertised mode on the current harness
 * (SPEC §3.4a). This is ADVISORY text the model can ignore, never a permission
 * boundary (SPEC risk Rw) — a consumer must present a prompt-enforced posture
 * as "advisory", never imply it sandboxes tools.
 *
 * `"default"` has no preamble: it is the neutral posture (no constraint to
 * announce), so it resolves to a no-op rather than an injected string when the
 * harness advertises no native `default` mode.
 */
export const POSTURE_PREAMBLES: Readonly<Record<Exclude<CanonicalPosture, "default">, string>> = {
  plan:
    "You are in PLAN mode. Investigate and propose a concrete plan for the " +
    "user to approve; do NOT edit files, run commands, or make any other " +
    "changes until the plan is explicitly approved. Reading and searching are " +
    "fine.",
  "accept-edits":
    "You are in ACCEPT-EDITS mode. File edits are auto-approved, so apply them " +
    "directly without pausing for confirmation on each one; commands and other " +
    "actions still warrant the usual care.",
  bypass:
    "You are in BYPASS-PERMISSIONS mode. No approval prompts will interrupt " +
    "you — every file edit and command runs without confirmation. Be " +
    "deliberate and careful: there is no safety prompt between you and a " +
    "destructive action.",
  "read-only":
    "You are in READ-ONLY mode. You may read, search, and analyze, but you " +
    "must NOT edit files, run commands that mutate state, or make any other " +
    "changes. Answer and advise only.",
}

/**
 * agentproto-canonical posture → the harness `SessionModeId`s that mean the
 * same thing. This is the "canonical posture ↔ advertised ACP mode id" map
 * (SPEC §3.4a): the daemon resolves a portable posture onto whichever native
 * mode a given harness happens to advertise, since harnesses spell the same
 * concept differently — claude-code's ACP wrapper uses `acceptEdits` /
 * `bypassPermissions` (`adapters/claude-code/src/index.ts:216,223`), the
 * manifest posture ids use `accept-edits` / `bypass-permissions`, codex uses
 * `full-access`, opencode uses `build`, etc.
 *
 * Matching is case- and separator-insensitive (see {@link normalizeModeId}), so
 * ONE readable spelling here covers every casing/hyphenation a harness might
 * advertise — `"accept-edits"` already matches claude-code's `acceptEdits`, so
 * both spellings need not be listed. Aliases are disjoint across postures — no
 * advertised id maps to two canonical postures — so {@link canonicalForModeId}
 * is unambiguous. Kept consistent with the legacy `mode`-id normalization in
 * `session-config.ts` (`POSTURE_MODE_VALUES`).
 */
export const POSTURE_NATIVE_ALIASES: Readonly<Record<CanonicalPosture, readonly string[]>> = {
  default: ["default", "build", "normal", "standard"],
  plan: ["plan", "planning", "plan-mode"],
  "accept-edits": ["accept-edits", "auto-accept", "auto-edit"],
  bypass: ["bypass", "bypass-permissions", "full-access", "yolo", "dangerously-skip-permissions"],
  "read-only": ["read-only", "chat", "ask"],
}

/**
 * The agentproto-canonical posture vocabulary as a runtime value list — exactly
 * the keys of {@link POSTURE_NATIVE_ALIASES}. Used by {@link parsePostureInput}
 * to tell a portable canonical value apart from a raw harness mode id at the
 * daemon's wire boundary.
 */
export const CANONICAL_POSTURES: readonly CanonicalPosture[] = Object.keys(
  POSTURE_NATIVE_ALIASES,
) as CanonicalPosture[]

const CANONICAL_POSTURE_SET: ReadonlySet<string> = new Set(CANONICAL_POSTURES)

/** True when `value` is one of the agentproto-canonical posture vocabulary values. */
export function isCanonicalPosture(value: string): value is CanonicalPosture {
  return CANONICAL_POSTURE_SET.has(value)
}

/**
 * Coerce a wire posture string (from `agent_set_posture` / `POST
 * /sessions/:id/posture`) into a {@link Posture}. A value in the portable
 * canonical vocabulary (`plan`, `bypass`, …) stays canonical so it resolves
 * against whatever native mode the harness spells it as (SPEC §3.4a); anything
 * else is taken as a raw harness mode id (`{ harnessModeId }`) — a native mode
 * the canonical vocabulary doesn't name (e.g. opencode's `architect`).
 */
export function parsePostureInput(raw: string): Posture {
  return isCanonicalPosture(raw) ? raw : { harnessModeId: raw }
}

/**
 * Normalize a mode id for matching: lowercase and strip every non-alphanumeric
 * character, so `"acceptEdits"`, `"accept-edits"`, and `"Accept_Edits"` all
 * collapse to `"acceptedits"`. Lets one readable alias in
 * {@link POSTURE_NATIVE_ALIASES} cover any casing/separator a harness advertises.
 */
export function normalizeModeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** normalized alias → canonical posture (built once from the alias map). */
const CANONICAL_BY_NORMALIZED_ALIAS: ReadonlyMap<string, CanonicalPosture> = (() => {
  const index = new Map<string, CanonicalPosture>()
  for (const [posture, aliases] of Object.entries(POSTURE_NATIVE_ALIASES) as [
    CanonicalPosture,
    readonly string[],
  ][]) {
    for (const alias of aliases) index.set(normalizeModeId(alias), posture)
  }
  return index
})()

/**
 * Inverse of the alias map: which canonical posture (if any) a harness mode id
 * normalizes to. `undefined` for a harness-specific mode the canonical
 * vocabulary doesn't name (e.g. opencode's `architect`) — such a mode is still
 * offerable as a raw `{ harnessModeId }` posture, it just has no portable name.
 */
export function canonicalForModeId(modeId: string): CanonicalPosture | undefined {
  return CANONICAL_BY_NORMALIZED_ALIAS.get(normalizeModeId(modeId))
}

/**
 * Find the advertised harness mode that natively enforces `posture`, or
 * `undefined` if none does.
 *
 * - A `CanonicalPosture` matches an advertised mode whose id normalizes to one
 *   of that posture's aliases.
 * - A raw `{ harnessModeId }` matches an advertised mode with the (normalized)
 *   same id — it's already a native id, we only confirm the session still
 *   advertises it.
 */
export function findNativeMode(
  posture: Posture,
  availableModes: readonly SessionMode[],
): SessionMode | undefined {
  if (typeof posture === "object") {
    const target = normalizeModeId(posture.harnessModeId)
    return availableModes.find(mode => normalizeModeId(mode.id) === target)
  }
  return availableModes.find(mode => canonicalForModeId(mode.id) === posture)
}

/**
 * How a requested posture resolves against a session's advertised modes.
 *
 * - `native` — an advertised mode enforces it; switch via `setSessionMode`
 *   (live, step 5) or apply on restart (step 6). A real permission boundary.
 * - `prompt` — no native mode; honour it as an injected system-prompt preamble
 *   (advisory only, SPEC risk Rw). Rides the system prompt, so it applies at
 *   spawn/restart, never live.
 * - `noop` — the `default` (neutral) posture with no advertised `default` mode:
 *   nothing to enforce and nothing to announce.
 * - `unavailable` — a raw `{ harnessModeId }` the session no longer advertises;
 *   it has no canonical name, so there is no preamble to fall back to. The
 *   caller surfaces this rather than silently doing nothing.
 */
export type PostureResolution =
  | { readonly kind: "native"; readonly mode: SessionMode }
  | {
      readonly kind: "prompt"
      readonly posture: Exclude<CanonicalPosture, "default">
      readonly preamble: string
    }
  | { readonly kind: "noop"; readonly posture: "default" }
  | { readonly kind: "unavailable"; readonly requestedModeId: string }

/**
 * Resolve a requested posture against the session's advertised `availableModes`
 * (from the #482 read surface) into one of the {@link PostureResolution} arms.
 * Pure and total — the single decision function steps 5 (live) and 6 (restart
 * override) call to learn whether a posture pick is native-enforced or
 * prompt-injected, without either of them re-deriving the map.
 *
 * Native enforcement is always preferred: a canonical posture resolves to
 * `prompt` ONLY when the harness advertises no equivalent mode.
 */
export function resolvePosture(
  posture: Posture,
  availableModes: readonly SessionMode[],
): PostureResolution {
  const native = findNativeMode(posture, availableModes)
  if (native) return { kind: "native", mode: native }

  // A raw harness mode id that the session doesn't advertise: no canonical
  // name, so no preamble fallback exists.
  if (typeof posture === "object") {
    return { kind: "unavailable", requestedModeId: posture.harnessModeId }
  }

  // Canonical posture with no native mode → prompt-injection fallback. `default`
  // is neutral: no preamble, nothing to enforce.
  if (posture === "default") return { kind: "noop", posture: "default" }
  return { kind: "prompt", posture, preamble: POSTURE_PREAMBLES[posture] }
}

/**
 * How a posture is actually ENFORCED on a session — the user-facing
 * distinction SPEC risk Rw asks every surface to keep honest:
 *
 * - `native` — an advertised harness mode enforces it (switchable live).
 * - `spawn-config` — no advertised mode, but the adapter enforces it as a real
 *   boundary through its own isolated spawn config (claude-code's
 *   `permissions.defaultMode`, opencode's per-session `permission` block —
 *   `AgentCliRuntimeSession.spawnEnforcedPostures`). Applies at
 *   spawn/restart, never live.
 * - `prompt-advisory` — only the injected preamble; the model can ignore it.
 * - `none` — the neutral `default` posture with nothing to enforce.
 * - `unavailable` — a raw harness mode id the session no longer advertises.
 */
export type PostureEnforcement = "native" | "spawn-config" | "prompt-advisory" | "none" | "unavailable"

/**
 * Classify a posture's enforcement from the session's advertised modes and the
 * canonical postures its adapter enforces at spawn. Pure; native wins, then
 * spawn config, and only then the advisory preamble.
 */
export function postureEnforcement(
  posture: Posture,
  availableModes: readonly SessionMode[],
  spawnEnforcedPostures: readonly string[] = [],
): PostureEnforcement {
  const resolution = resolvePosture(posture, availableModes)
  switch (resolution.kind) {
    case "native":
      return "native"
    case "prompt":
      return spawnEnforcedPostures.includes(resolution.posture) ? "spawn-config" : "prompt-advisory"
    case "noop":
      return "none"
    case "unavailable":
      return "unavailable"
  }
}

/**
 * The {@link Posture} a harness mode id reports itself as: the canonical
 * posture when the id maps to one through {@link canonicalForModeId}, else the
 * raw native id (`{ harnessModeId }`), e.g. mastra-controller's `execute`.
 * Used to fold an agent-caused AIP-45 `mode-changed` back onto the session
 * descriptor's `posture` axis.
 */
export function postureForModeId(modeId: string): Posture {
  return canonicalForModeId(modeId) ?? { harnessModeId: modeId }
}

/** True when two postures name the same mode (canonical or normalized raw id). */
export function samePosture(a: Posture | undefined, b: Posture | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const key = (p: Posture) => (typeof p === "object" ? postureForModeId(p.harnessModeId) : p)
  const ka = key(a)
  const kb = key(b)
  if (typeof ka === "object" || typeof kb === "object") {
    return (
      typeof ka === "object" &&
      typeof kb === "object" &&
      normalizeModeId(ka.harnessModeId) === normalizeModeId(kb.harnessModeId)
    )
  }
  return ka === kb
}

/**
 * How much a canonical posture lets the agent do without asking, for the
 * caller-ceiling check. `plan` ranks with `default`: plan is a phase the agent
 * is expected to leave once its plan is approved, so leaving it for the normal
 * approval mode is not a widening, while leaving it for `accept-edits` or
 * `bypass` is.
 */
const POSTURE_PERMISSIVENESS: Readonly<Record<CanonicalPosture, number>> = {
  "read-only": 0,
  plan: 1,
  default: 1,
  "accept-edits": 2,
  bypass: 3,
}

function postureRank(posture: Posture | undefined): number | undefined {
  // No caller posture: the harness started in its own default.
  if (posture === undefined) return POSTURE_PERMISSIVENESS.default
  const canonical = typeof posture === "object" ? canonicalForModeId(posture.harnessModeId) : posture
  return canonical === undefined ? undefined : POSTURE_PERMISSIVENESS[canonical]
}

/**
 * True when `posture` lets the agent do more than the caller's `ceiling`.
 * Only canonical postures are ranked: a native mode the canonical vocabulary
 * does not name (on either side) cannot be compared, so it is never reported
 * as a widening.
 */
export function exceedsPostureCeiling(posture: Posture | undefined, ceiling: Posture | undefined): boolean {
  const rank = postureRank(posture)
  const ceilingRank = postureRank(ceiling)
  return rank !== undefined && ceilingRank !== undefined && rank > ceilingRank
}

/**
 * The posture a restart starts in: the session's CURRENT posture, clamped to
 * the caller's ceiling when the agent itself moved past it
 * (`postureSource: "agent"`). A clamp returns the ceiling as the caller set it,
 * `undefined` included (the adapter's own default).
 */
export function restartPosture(desc: {
  posture?: Posture
  postureCeiling?: Posture
  postureSource?: "agent"
}): Posture | undefined {
  if (desc.postureSource !== "agent") return desc.posture
  return exceedsPostureCeiling(desc.posture, desc.postureCeiling) ? desc.postureCeiling : desc.posture
}
