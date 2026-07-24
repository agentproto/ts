/**
 * Named auth-profile types (SPEC §1c/§3.1 — `agentproto-session-config-axes`).
 *
 * A profile is a named credential `{ endpoint, method, credentialRef }` that
 * lives independently of any adapter, generalizing `providers-store`'s
 * `ProviderEntry` (one api-key per provider, `packages/providers-store/src/
 * index.ts:68-80`) to N named profiles per billing endpoint. `subscription|api-key` is
 * not a session property — it demotes to the `method` facet of a profile.
 *
 * The secret itself is NEVER inlined here — `credentialRef` is an opaque
 * handle into this package's own credential storage (`store/types.ts`'s
 * `CredentialStore` / `token-store.ts`), matching how the rest of
 * `@agentproto/auth` already fingerprints rather than echoes secrets
 * (`broker.ts`, `KeychainStore`).
 */

/** How a profile authenticates — the narrow eligibility gate (not adapter
 *  identity). Mirrors `@agentproto/auth`'s `FlowResult.tokenKind`
 *  (`types.ts:151`): `pat` → `api-key`, `oat` → `oauth-bearer`. Extensible —
 *  new methods are additive. */
export type AuthMethod = "oauth-bearer" | "api-key"

/** Per-profile model curation (the allowlist). `mode: "all"` (or an ABSENT
 *  {@link AuthProfile.models}) services every model the profile is otherwise
 *  eligible for — today's behavior. `mode: "allow"` narrows the profile to
 *  exactly `ids`: it services a model only when the model's catalog identity
 *  (its `vendor/product` or its route-qualified `ref`) is in the list. The
 *  intersection is applied INSIDE the catalog eligibility join
 *  (`catalog-models.ts`), never at the endpoint/method predicate here, so a
 *  curated profile stays endpoint-eligible but only makes its chosen model
 *  refs runnable. */
export interface ModelCuration {
  mode: "all" | "allow"
  /** Model identities allowed when `mode === "allow"` — each a catalog
   *  `vendor/product` or route-qualified `ref`. Empty ⇒ services nothing. */
  ids: string[]
}

/** Which spend surface a {@link CostBudget} caps. `"session"` bounds the
 *  windowed spend of the ONE session the budget is evaluated against;
 *  `"profile"` bounds the aggregate windowed spend of every session that
 *  resolved to the same auth profile (the session's `accessProfile.profileRef`).
 *  Additive — new scopes are back-compat. */
export type CostBudgetScope = "session" | "profile"

/** A windowed spend cap. DISTINCT from the scalar `maxCostUsd` session-kill
 *  (`sessions.ts` turn-end) — a `CostBudget` never kills a session; it trips a
 *  governance policy (`policy:failed` on the completion-policy bus) when the
 *  ROLLING windowed spend for its {@link scope} crosses `maxCostUsd`. `window`
 *  is a rolling spec (`parseWindow` shorthand `"5h"`/`"7d"` or ISO-8601 `"P7D"`);
 *  spend is the priced local-estimate rollup over durable usage snapshots. */
export interface CostBudget {
  /** Windowed spend ceiling in USD. The budget trips when the window's priced
   *  spend strictly exceeds this. */
  maxCostUsd: number
  /** Rolling window spec — `parseWindow`-parseable (`"5h"`, `"7d"`, `"P7D"`). */
  window: string
  /** Which spend surface the window is summed over. See {@link CostBudgetScope}. */
  scope: CostBudgetScope
}

/** A named, billing-endpoint-scoped credential reference. */
export interface AuthProfile {
  /** Stable id, unique across all profiles (the `profileRef` a session
   *  attaches). */
  id: string
  /** Which billing endpoint this credential authenticates against
   *  (`anthropic`, `openrouter`, `moonshot`, …). This deliberately does NOT
   *  mean the model builder: OpenRouter can serve a z-ai model, for example.
   *  Kept as `string` here to stay decoupled from
   *  `@agentproto/model-catalog`, same rationale as the driver's
   *  `AgentCliDefinition.provider`. */
  endpoint: string
  /** How this profile authenticates. */
  method: AuthMethod
  /** Opaque handle into this package's credential storage — NEVER the secret
   *  itself. Resolved through `CredentialStore` / `token-store.ts` at use
   *  time, not stored inline. Set for a credential-backed profile; absent for
   *  a source-backed profile. Mutually exclusive with {@link source}. */
  credentialRef?: string
  /** Self-refreshing credential source (`oauth-bearer` only) — same value
   *  spawn's subscription resolution accepts (today, only
   *  `"claude-code-oauth"`, `spawn-defaults.ts`'s `CLAUDE_CODE_OAUTH_SOURCE`).
   *  A source-backed profile has no stored secret: the credential is resolved
   *  fresh at spawn time instead. Mutually exclusive with
   *  {@link credentialRef}. */
  source?: string
  /** Optional human-readable name ("Jeremy Max", "work OpenRouter"). */
  label?: string
  /** Whole-profile enable/disable. ABSENT (or `false`) ⇒ enabled (today's
   *  behavior). `true` ⇒ the profile is skipped by {@link eligibleProfiles}
   *  entirely, so every model it would otherwise service drops to
   *  non-runnable. A REAL persisted state, distinct from the derived
   *  `runnable` flag the catalog computes. */
  disabled?: boolean
  /** Optional per-model curation (the allowlist). ABSENT ⇒ `{ mode: "all" }`
   *  — services every eligible model, byte-identical to a profile that
   *  predates this field. See {@link ModelCuration}. */
  models?: ModelCuration
  /** Optional windowed spend cap attached to this profile (SPEC §1c). ABSENT ⇒
   *  no profile-level budget — byte-identical to a profile that predates this
   *  field. When present with `scope: "profile"`, a governance policy evaluates
   *  the aggregate windowed spend of every session on this profile at each
   *  turn-end and trips `policy:failed` on overage. Distinct from the scalar
   *  session-kill `maxCostUsd` — see {@link CostBudget}. */
  costBudget?: CostBudget
  /** Provenance: where this profile's credential was IMPORTED from, when it
   *  was materialized by the WS6 discovery→import flow
   *  (`auth_profile_import`) rather than created by hand. One of the discovery
   *  origins (`claude-code`, `hermes-config`, `env`, `codex`, `gemini`). Purely
   *  informational — it drives the panel's "imported from <origin>" badge and
   *  nothing in the spawn/eligibility path. ABSENT for a hand-created profile.
   *  Kept as `string` (not a union) to stay decoupled, same rationale as
   *  {@link endpoint}. */
  origin?: string
}
