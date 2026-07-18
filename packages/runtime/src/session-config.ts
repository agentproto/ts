/**
 * SessionConfig — the unified per-session config surface, decomposed into
 * orthogonal axes (SPEC §3.1: `_agentproto-worktrees/agentik-studio/…
 * SPEC.md`, out-of-repo design doc). Pure types + a `decomposeMode`/
 * `composeMode` shim over the legacy AIP-45 `mode` string — no I/O, no
 * runtime wiring, no adapter behavior change.
 */

/** "low"|"medium"|"high"|"xhigh"|"max"|"ultracode" — `adapters/claude-code/src/index.ts`'s `effort` enum. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"

/** Facet of a named auth profile — how it authenticates, not who it's for (SPEC §1c). */
export type AuthMethod = "api-key" | "oauth-bearer"

/** What the agent may DO. A superset over adapters' own posture vocabulary
 *  (SPEC §3.1) — see `POSTURE_MODE_VALUES` for how other adapters' ids map in. */
export type Posture = "default" | "plan" | "accept-edits" | "bypass" | "read-only"

/** Endpoint / billing rail. `gateway` is a preset id ("anthropic", "moonshot", …)
 *  or a custom id paired with an explicit `baseUrl` override. */
export interface RouteSpec {
  gateway: string
  baseUrl?: string
}

/** What enters context. "lean" drops bundled skills (SPEC §3.1); any other
 *  string is accepted so a future adapter-declared profile isn't blocked. */
export type ContextProfile = "full" | "lean" | (string & {})

/**
 * The complete per-session config surface, decomposed into orthogonal axes.
 * Every field optional; omission = "adapter default" for that axis.
 */
export interface SessionConfig {
  model?: string
  effort?: EffortLevel
  /** Attach a NAMED auth profile (SPEC §1c). Omit ⇒ default profile. */
  access?: { profileRef?: string }
  route?: RouteSpec
  posture?: Posture
  contextProfile?: ContextProfile
}

/**
 * Manifest-declared AIP-45 mode id + axis discriminant — the minimum
 * `decomposeMode`/`composeMode` need from `AgentCliMode` (driver
 * `types.ts`). Mirrors its `id`/`kind` fields without importing
 * `@agentproto/driver-agent-cli` into the runtime package (same
 * structural-type pattern as `DeclaredAdapterOption` in
 * `spawn-defaults.ts` and `DeclaredAdapterPreset` in `preset-tools.ts`).
 */
export interface DeclaredAdapterMode {
  id: string
  kind?: "posture" | "route" | "context"
}

/** Gateway-preset ids inferred as the `route` axis when a mode declares no
 *  explicit `kind` (SPEC §3.5 classification order, step 2). */
const GATEWAY_MODE_IDS: ReadonlySet<string> = new Set([
  "moonshot",
  "openrouter",
  "requesty",
  "deepseek",
])

/**
 * Legacy posture-mode ids, normalized to the canonical `Posture` enum (the
 * "superset over adapters"). Some ids don't literally match a `Posture`
 * member because they're another adapter's own vocabulary — codex's
 * `full-access` (auto-approve every file/shell op, trusted-sandbox only) is
 * the same trust level as `bypass`; mastracode/opencode's `build` ("not
 * planning, normal execution") is the same trust level as `default`.
 */
const POSTURE_MODE_VALUES: Readonly<Record<string, Posture>> = {
  default: "default",
  plan: "plan",
  "accept-edits": "accept-edits",
  "bypass-permissions": "bypass",
  "read-only": "read-only",
  "full-access": "bypass",
  build: "default",
}

function inferModeKind(modeId: string): "posture" | "route" | "context" {
  if (GATEWAY_MODE_IDS.has(modeId)) return "route"
  if (modeId in POSTURE_MODE_VALUES) return "posture"
  return "context"
}

/**
 * Map ONE legacy `mode` id (AIP-45 `modes[]`) onto its orthogonal axis.
 * Classification order: (1) the mode's own explicit `kind` tag; (2)
 * inference fallback over well-known ids (gateway ids ⇒ route, known
 * posture ids ⇒ posture); (3) a truly-unknown id defaults to
 * `contextProfile` — least-privilege, since defaulting to `posture` or
 * `route` could silently grant elevated permissions or reroute billing.
 */
export function decomposeMode(
  modes: readonly DeclaredAdapterMode[],
  modeId: string,
): Partial<SessionConfig> {
  const declared = modes.find(mode => mode.id === modeId)
  const kind = declared?.kind ?? inferModeKind(modeId)
  if (kind === "route") return { route: { gateway: modeId } }
  if (kind === "posture") return { posture: POSTURE_MODE_VALUES[modeId] ?? "default" }
  return { contextProfile: modeId }
}

function decomposedAxisMatches(
  cfg: Partial<SessionConfig>,
  decomposed: Partial<SessionConfig>,
): boolean {
  if (decomposed.route) return cfg.route?.gateway === decomposed.route.gateway
  if (decomposed.posture) return cfg.posture === decomposed.posture
  if (decomposed.contextProfile !== undefined) {
    return cfg.contextProfile === decomposed.contextProfile
  }
  return false
}

/**
 * The reverse of `decomposeMode` — picks the single legacy mode id whose
 * decomposition matches `cfg`'s route/posture/contextProfile axis. Display/
 * back-compat echo only: the driver applies each axis's env/argv patch
 * directly, so nothing consumes this to spawn. Returns undefined when no
 * declared mode matches.
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
