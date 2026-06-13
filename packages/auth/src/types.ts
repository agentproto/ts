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

/** Discriminated union of all supported auth flow ids. */
export type FlowId = "pat" | "service-auth"

/** Where a credential is stored in the platform Keychain. */
export interface TokenStoreSpec {
  /** macOS Keychain service name (or equivalent on other platforms). */
  keychain: string
  /** Keychain account. The literal `{server}` is substituted with the resolved
   *  server URL. Defaults to the resolved server URL when omitted. */
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
  /** Keychain destination for the long-lived credential. The primary slot holds
   *  the rotating refresh token (`ort_*`, ~30d) so the credential outlives the
   *  short `oat_*` window; on a server that doesn't rotate, the access token is
   *  stored as a fallback. The identity_assertion, when issued, is stored
   *  separately in a derived `<keychain>-assertion` slot for jwt-bearer
   *  re-exchange. The raw `oat_*` access token is never the persisted primary. */
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
 *  durable credential to the Keychain (refresh token in the primary slot,
 *  assertion in the `-assertion` slot); these fields are the in-memory values
 *  the caller uses for the current invocation. */
export interface FlowResult {
  /** Service-signed identity assertion JWT (service-auth flow), when the server
   *  issues one. The engine has stored it in the `<keychain>-assertion` slot for
   *  future jwt-bearer re-exchange; surfaced here for immediate use. */
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
