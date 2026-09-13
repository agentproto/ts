/**
 * SessionConfig — the unified per-session config surface, decomposed into
 * orthogonal axes (SPEC §3.1, out-of-repo design doc
 * `agentproto-session-config-axes/SPEC.md`). Pure types + a `decomposeMode`/
 * `composeMode` shim over the legacy AIP-45 `mode` string — no I/O, no runtime
 * wiring, no adapter behavior change. This is the additive type foundation
 * (SPEC §7.2 build step 1); the live spawn-path extraction (deleting gateway
 * modes, sourcing posture from the ACP registry) is a separate later step.
 *
 * Boundary note: this module deliberately does NOT import from
 * `@agentproto/auth`. `packages/runtime` intentionally has no dependency on
 * that package (`mcp-credential-deps.ts:1-9`), so the named-profile record it
 * owns — `AuthProfile` (`packages/auth/src/profile-types.ts:24`, shipped in
 * #470) — is referenced by citation, never redefined here: the `access` axis
 * only needs a `profileRef` string, and the profile record itself stays in
 * `@agentproto/auth`. The narrow `AuthMethod` *facet*, by contrast, is
 * structurally mirrored below (§3.1) — the descriptor's `accessProfile` echo
 * (§3.7) names it, and mirroring a two-value string union is cheaper than
 * taking a package dependency on `@agentproto/auth` for it, the same
 * structural-mirror rationale as `DeclaredAdapterMode` (below) and
 * `DeclaredAdapterOption` (`spawn-defaults.ts:447`).
 *
 * It DOES, however, import a VALUE — the legacy AIP-45 mode-id classification
 * (`inferLegacyModeKind`) — from `@agentproto/driver-agent-cli` (a lean,
 * acyclic runtime → driver edge; the driver never depends back on the runtime).
 * Unlike the type mirrors above (a mirror can't silently break — the compiler
 * still checks structural compatibility), the gateway/posture id SET is a value
 * list needed on BOTH sides of the driver/runtime boundary — here for
 * `decomposeMode` and in the driver's `composeSpawn` back-compat shim — so it
 * is single-sourced in the driver (its AIP-45 home) rather than copied, which
 * for a value list WOULD silently drift. Only the daemon-domain canonical-
 * posture VALUE mapping (`POSTURE_MODE_VALUES`) stays local.
 */

import { inferLegacyModeKind } from "@agentproto/driver-agent-cli"
// A `type`-only import (erased at compile — no runtime edge). `CostBudget` is a
// pure record in `@agentproto/auth`, a package strictly BELOW runtime in the
// layer stack (and already a workspace dependency, `package.json`), so naming
// its windowed-spend type here — unlike the structurally-mirrored `AuthMethod`
// facet below — takes no value dependency and cannot introduce a cycle.
import type { CostBudget } from "@agentproto/auth"
import type { ContextContinuityPolicy } from "./context-continuity.js"

/**
 * Reasoning / compute budget label.
 *
 * SUPERSET ONLY — this flat union is the documented ceiling, NOT the valid set.
 * The real accepted values are a function of (adapter × model), resolved at
 * runtime (SPEC §3.9): the same label maps to a different compute budget across
 * models, and `"max"` / `"ultracode"` are session-only and model-gated (opus
 * offers `ultracode`, haiku does not —
 * `adapters/claude-code/src/index.ts:310-321`). Consumers must resolve the
 * offerable set per session/model, never treat this enum as authoritative.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"

/**
 * agentproto-canonical posture — a portable, normalized vocabulary for "what
 * the agent may DO" (SPEC §3.1/§3.4a). A canonical posture resolves to a
 * harness `SessionModeId` when the session's advertised `availableModes` has an
 * equivalent (native, enforced, live via `setSessionMode`); otherwise it is
 * applied as an injected system-prompt preamble (advisory, not a permission
 * boundary — SPEC risk Rw).
 */
export type CanonicalPosture = "default" | "plan" | "accept-edits" | "bypass" | "read-only"

/**
 * The posture axis: either an agentproto-canonical posture OR a raw harness
 * mode id sourced directly from the harness's own ACP mode registry
 * (`SessionModeState.availableModes` — SDK `types.gen.d.ts:4227`). Postures are
 * NOT a manifest mode list going forward (SPEC §3.4a); the `{ harnessModeId }`
 * form carries a native mode the canonical vocabulary doesn't name.
 */
export type Posture = CanonicalPosture | { harnessModeId: string }

/**
 * Endpoint / billing rail — model/route config, NOT a mode (SPEC §3.4a). A
 * gateway is reached by resolving the model's `@route` against the catalog
 * (`packages/model-catalog/src/route-identity/index.ts:1-46`) and applying its
 * base_url + credential-scrub on the route apply-path; `access` (which profile
 * is eligible) is downstream of THIS axis (SPEC §1c).
 */
export interface RouteSpec {
  /** Preset id ("anthropic"/direct, "moonshot", "openrouter", "requesty",
   *  "deepseek") or a custom id paired with an explicit `baseUrl`. */
  gateway: string
  /** Resolved base URL; carried only for a custom gateway the catalog can't
   *  resolve. The attached profile's credential is resolved separately (§1c),
   *  never inlined here. */
  baseUrl?: string
}

/**
 * What enters context. `"lean"` drops bundled skills
 * (`adapters/claude-code/src/index.ts:196-204`); `"full"` is the default. The
 * `(string & {})` arm keeps a future adapter-declared context profile from
 * being blocked while preserving literal autocompletion for the known values.
 */
export type ContextProfile = "full" | "lean" | (string & {})

/**
 * How an attached auth profile authenticates — the narrow eligibility gate,
 * a *facet* of a named profile (SPEC §1c/§3.1), NOT a session-level enum. A
 * structural mirror of `@agentproto/auth`'s `AuthMethod`
 * (`packages/auth/src/profile-types.ts:21`, #470): `"api-key"` ↔ `tokenKind
 * "pat"`, `"oauth-bearer"` ↔ `tokenKind "oat"` (a subscription bearer). Kept
 * here — rather than imported — because `packages/runtime` has no dependency
 * on `@agentproto/auth` (see the boundary note above); only the descriptor's
 * `accessProfile` echo (§3.7) needs to name it.
 */
export type AuthMethod = "oauth-bearer" | "api-key"

/**
 * The complete per-session config surface, decomposed into orthogonal axes
 * (SPEC §3.1). Every field optional; omission = "adapter default" for that
 * axis. The decomposed axes are the canonical form — persistence and transport
 * use these fields, never a recomposed legacy `mode` string (SPEC §3.8).
 */
export interface SessionConfig {
  // ── LIVE-switchable (ACP session/set_config_option, no respawn) ──
  /** Route-identity ref: `[route:]vendor/product[:pin][@route]`
   *  (`packages/model-catalog/src/route-identity/index.ts:1-46`). */
  model?: string
  effort?: EffortLevel

  // ── RESTART-only (spawn-time env/argv rewrite) ──
  /** Attach a NAMED auth profile by id (SPEC §1c). The profile record —
   *  `AuthProfile { id, endpoint, method, credentialRef, label? }` — lives in
   *  `@agentproto/auth` (`packages/auth/src/profile-types.ts:24`, #470), NOT on
   *  the session and NOT in `providers.json`. Omit ⇒ default profile. */
  access?: { profileRef?: string }
  /** Endpoint / gateway rail; `access` is downstream of this (SPEC §1c). */
  route?: RouteSpec
  /** What the agent may DO. */
  posture?: Posture
  /** What enters context. */
  contextProfile?: ContextProfile
  /** Windowed cost-budget cap (SPEC §1c). A RESTART-only axis: it is read at
   *  spawn time to auto-attach a governance policy that trips `policy:failed`
   *  when the session's (or its profile's) ROLLING windowed spend crosses the
   *  cap. DISTINCT from the scalar `maxCostUsd` session-kill — a `costBudget`
   *  never kills the session, it only trips a policy. The record lives in
   *  `@agentproto/auth` (`CostBudget { maxCostUsd, window, scope }`). Omit ⇒ no
   *  windowed budget. */
  costBudget?: CostBudget
  /** Configurable context-continuity policy for this session — controls
   *  warning/compact/continue-fresh thresholds and checkpoint sections. */
  contextContinuity?: ContextContinuityPolicy
  /** Adapter harness slug — the canonical name for the adapter that runs the
   *  session (e.g. 'claude-code', 'hermes'). This is the same value historically
   *  carried on the wire as `adapter` / `adapterSlug`; the `harness` field is the
   *  canonical descriptor identity and remains optional for back-compat. */
  harness?: string
}

/**
 * Manifest-declared AIP-45 mode id + axis discriminant — the minimum
 * `decomposeMode`/`composeMode` need from `AgentCliMode` (driver `types.ts`).
 * Mirrors its `id`/`kind` fields structurally rather than importing the full
 * `AgentCliMode` TYPE surface from `@agentproto/driver-agent-cli` — the same
 * structural-mirror pattern as `DeclaredAdapterOption` (`spawn-defaults.ts:447`)
 * and `DeclaredAdapterPreset` (`preset-tools.ts`). (The module does take a
 * value-level import — `inferLegacyModeKind` — from that package; see the
 * boundary note at the top for why a shared value list is single-sourced, not
 * mirrored.)
 *
 * `kind` narrows to a single meaningful value going forward — `"context"` (the
 * one axis with no ACP-protocol home); routes come from the catalog and
 * postures from the harness's ACP registry (SPEC §3.4a). `"posture"`/`"route"`
 * remain accepted so `decomposeMode` can still classify a LEGACY tagged
 * manifest during migration.
 */
export interface DeclaredAdapterMode {
  id: string
  kind?: "posture" | "route" | "context"
}

/**
 * Legacy posture-mode ids, normalized to the `CanonicalPosture` vocabulary
 * (the "superset over adapters"). Some ids don't literally match a
 * `CanonicalPosture` member because they're another adapter's own vocabulary —
 * codex's `full-access` (auto-approve every file/shell op, trusted-sandbox
 * only) is the same trust level as `bypass`; opencode's `build` ("not
 * planning, normal execution") is the same trust level as `default`.
 *
 * This is the daemon-domain VALUE mapping only; the id CLASSIFICATION (which
 * ids are route vs posture) is single-sourced in `@agentproto/driver-agent-cli`
 * (`inferLegacyModeKind`). Its keys are exactly {@link LEGACY_POSTURE_MODE_IDS}
 * from that same module — a unit test asserts they don't drift.
 */
const POSTURE_MODE_VALUES: Readonly<Record<string, CanonicalPosture>> = {
  default: "default",
  plan: "plan",
  "accept-edits": "accept-edits",
  "bypass-permissions": "bypass",
  "read-only": "read-only",
  "full-access": "bypass",
  build: "default",
}

/**
 * Map ONE legacy `mode` id (AIP-45 `modes[]`) onto its orthogonal axis
 * (SPEC §3.5). Classification order: (1) the mode's own explicit `kind` tag;
 * (2) inference over well-known ids (gateway ids ⇒ route, known posture ids ⇒
 * posture); (3) a truly-unknown id defaults to `contextProfile` —
 * least-privilege, since defaulting to `posture` or `route` could silently
 * grant elevated permissions or reroute billing (SPEC risk R4).
 *
 * Always yields a `CanonicalPosture` for the posture axis, never a
 * `{ harnessModeId }` — the shim speaks the portable vocabulary only; raw
 * harness modes come from the ACP registry, not a legacy `mode` id.
 */
export function decomposeMode(
  modes: readonly DeclaredAdapterMode[],
  modeId: string,
): Partial<SessionConfig> {
  const declared = modes.find(mode => mode.id === modeId)
  const kind = declared?.kind ?? inferLegacyModeKind(modeId)
  if (kind === "route") return { route: { gateway: modeId } }
  if (kind === "posture") return { posture: POSTURE_MODE_VALUES[modeId] ?? "default" }
  return { contextProfile: modeId }
}

function decomposedAxisMatches(
  cfg: Partial<SessionConfig>,
  decomposed: Partial<SessionConfig>,
): boolean {
  if (decomposed.route) return cfg.route?.gateway === decomposed.route.gateway
  if (decomposed.posture !== undefined) return cfg.posture === decomposed.posture
  if (decomposed.contextProfile !== undefined) {
    return cfg.contextProfile === decomposed.contextProfile
  }
  return false
}

/**
 * The reverse of `decomposeMode` — picks the single legacy mode id whose
 * decomposition matches `cfg`.
 *
 * LOSSY / display-and-back-compat ONLY (SPEC §3.8). A single legacy `mode`
 * string cannot represent an orthogonal combination — `{ posture: "plan",
 * route: { gateway: "moonshot" } }` has no single legacy id — so `composeMode`
 * returns the FIRST declared mode whose axis matches and silently drops the
 * rest. It is NEVER a storage or transport form: the driver applies each axis's
 * env/argv patch directly, and anything that must persist/transmit config uses
 * the decomposed axes. Returns undefined when no declared mode matches.
 */
export function composeMode(
  cfg: Partial<SessionConfig>,
  modes: readonly DeclaredAdapterMode[],
): string | undefined {
  for (const mode of modes) {
    if (decomposedAxisMatches(cfg, decomposeMode(modes, mode.id))) return mode.id
  }
  return undefined
}
