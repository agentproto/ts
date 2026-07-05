/**
 * AIP-50 auth-provider doctype — types.
 *
 * An auth-provider declares, for one API server, HOW a CLI tool or agent
 * authenticates (the `auth:` section) and WHERE to call the AIP-19 provision
 * endpoints (the `install:` section). It holds configuration, never
 * credentials — the flow engine reads/prompts credentials at runtime.
 *
 * Two flows are specified in v1:
 *   - `pat`          — read an existing Keychain token or prompt for a PAT
 *   - `service-auth` — auth.md claim ceremony (RFC 8628 + JWT-bearer)
 *
 * `id-jag` is reserved for a future agentproto-as-IdP scenario.
 */

import type { CredentialStore } from "./store/types.js"

/** Discriminated union of all supported auth flow ids. */
export type FlowId = "pat" | "service-auth"

/** Where a credential is stored, backend-agnostic. */
export interface TokenStoreSpec {
  /** macOS Keychain service name (or equivalent on other platforms).
   *  Back-compat alias for `path` — used when `path` is omitted. */
  keychain: string
  /** Storage slot key, passed to `CredentialStore` as `StoreRef.path`.
   *  Defaults to `keychain` when omitted. */
  path?: string
  /** Storage account/sub-slot. The literal `{server}` is substituted with the
   *  resolved server URL. Defaults to the resolved server URL when omitted. */
  account?: string
}

/** PAT flow: read existing Keychain token or prompt for one interactively. */
export interface PATAuthConfig {
  flow: "pat"
  tokenStore: TokenStoreSpec
}

/** service-auth flow: auth.md claim ceremony.
 *  Discovery (/.well-known/) determines the actual endpoints at runtime;
 *  the static fields here are used when discovery fails. */
export interface ServiceAuthConfig {
  flow: "service-auth"
  /** OAuth client id sent to /agent/identity. Default: "agentproto-cli". */
  clientId?: string
  /** Optional login_hint (email) passed to /agent/identity. */
  loginHint?: string
  /** Keychain destination for the durable credential. Per AIP-50 the stored
   *  credential is the `identity_assertion` JWT — re-exchanged via the
   *  jwt-bearer grant for a fresh access token. The access token is ephemeral
   *  and MUST NOT be persisted; the claim_token is held in memory only. */
  tokenStore: TokenStoreSpec
}

export type AuthConfig = PATAuthConfig | ServiceAuthConfig

/** AIP-19 companion: the provision endpoints on the server side. */
export interface InstallConfig {
  /** URL path for the seal-key endpoint (e.g. "/api/v1/connectors/seal-key"). */
  sealKey: string
  /** URL path template for the secret-backed install endpoint.
   *  May contain `{guildId}` which the caller substitutes at provision time. */
  secretBacked: string
}

export interface AuthProviderDefinition {
  /** Provider id — kebab/dot, 2–80 chars (AIP cross-id pattern). */
  id: string
  /** Human/LLM-facing prose; ≤2000 chars. */
  description: string
  /** Canonical API base URL (no trailing slash). */
  apiBase: string
  /** Authentication configuration. */
  auth: AuthConfig
  /** Optional AIP-19 provision target. */
  install?: InstallConfig
}

export type AuthProviderHandle = Readonly<AuthProviderDefinition>

/** Resolved endpoint set from the two-hop auth.md discovery chain. */
export interface DiscoveredEndpoints {
  /** Canonical API resource URL from PRM. */
  resource: string
  /** Human name from PRM, if present. */
  resourceName?: string
  /** Authorization server base URL. */
  authServerBase: string
  /** Full token endpoint URL. */
  tokenEndpoint: string
  /** Full revocation endpoint URL, if present. */
  revocationEndpoint?: string
  /** Full identity endpoint URL (POST /agent/identity). */
  identityEndpoint: string
  /** Full claim endpoint URL (POST /agent/identity/claim), if present. */
  claimEndpoint?: string
  /** Supported identity types from agent_auth.identity_types_supported. */
  identityTypesSupported: string[]
  /** Supported grant types from AS metadata. */
  grantTypesSupported: string[]
}

/** Result of a completed auth flow. The engine has already persisted the
 *  durable credential to the Keychain (for service-auth, the identity_assertion
 *  in the primary slot); these fields are the in-memory values the caller uses
 *  for the current invocation. */
export interface FlowResult {
  /** Service-signed identity assertion JWT (service-auth flow), when the server
   *  issues one. The engine has stored it in the Keychain (primary slot) as the
   *  durable credential for jwt-bearer re-exchange; surfaced here too. */
  identityAssertion?: string
  /** ISO 8601 expiry of the identity assertion. */
  assertionExpires?: string
  /** Access token to use for this invocation — `pat` returns the stored/typed
   *  key; `service-auth` returns the freshly minted/refreshed `oat_*`. */
  accessToken?: string
  /** What `accessToken` is: `pat` (personal access key), `oat` (service-auth
   *  access token). `assertion` is reserved for a future flow that returns a
   *  bare assertion without an access token. */
  tokenKind: "pat" | "assertion" | "oat"
}

export interface FlowRunOptions {
  /** Resolved server URL for this invocation. May differ from provider.apiBase
   *  when the user passes --server explicitly. */
  server: string
  /** Force re-authentication even if a stored credential is found. */
  force?: boolean
  signal?: AbortSignal
  /** Credential backend to read/write through. Defaults to a `KeychainStore`
   *  when omitted — existing callers keep today's Keychain-only behavior. */
  store?: CredentialStore
}

/** A flow engine implements one auth protocol. Dispatch by provider.auth.flow —
 *  no if/switch chains at call sites. */
export interface FlowEngine {
  readonly id: FlowId
  run(
    provider: AuthProviderHandle,
    discovered: DiscoveredEndpoints | null,
    opts: FlowRunOptions,
  ): Promise<FlowResult>
}
