/**
 * Named auth-profile types (SPEC §1c/§3.1 — `agentproto-session-config-axes`).
 *
 * A profile is a named credential `{ vendor, method, credentialRef }` that
 * lives independently of any adapter, generalizing `providers-store`'s
 * `ProviderEntry` (one api-key per provider, `packages/providers-store/src/
 * index.ts:68-80`) to N named profiles per vendor. `subscription|api-key` is
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

/** A named, vendor-scoped credential reference. */
export interface AuthProfile {
  /** Stable id, unique across all profiles (the `profileRef` a session
   *  attaches). */
  id: string
  /** Which vendor this credential bills against (`anthropic`, `moonshot`, …) —
   *  a `CatalogProvider` id, kept as `string` here to stay decoupled from
   *  `@agentproto/model-catalog`, same rationale as the driver's
   *  `AgentCliDefinition.provider`. */
  vendor: string
  /** How this profile authenticates. */
  method: AuthMethod
  /** Opaque handle into this package's credential storage — NEVER the secret
   *  itself. Resolved through `CredentialStore` / `token-store.ts` at use
   *  time, not stored inline. */
  credentialRef: string
  /** Optional human-readable name ("Jeremy Max", "work OpenRouter"). */
  label?: string
}
