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
}
