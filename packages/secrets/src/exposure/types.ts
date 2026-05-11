/**
 * SecretExposure — describes HOW a secret value reaches the runtime
 * that needs it (env var, config file, egress placeholder, future
 * MCP-header injection, future HTTP-bearer routing, …).
 *
 * Distinct from `SecretEntry` (AIP-19), which describes the secret's
 * *declaration* (slug, kind, access policy). Exposure is a *runtime*
 * concern — same secret might be exposed multiple ways across hosts.
 *
 * Discriminated union by `kind` so each new mechanism slots in as one
 * variant rather than another top-level field on whatever catalog the
 * host uses to map secrets onto agent runtimes.
 *
 * # Why this lives here (not in @agentproto/egress)
 * The substitution sigil + the "what surfaces does this secret have"
 * vocabulary are properties of the secret itself — they describe its
 * exposure surface independent of WHO consumes it. Egress is one
 * consumer; future ones (MCP servers, HTTP relays) are others.
 *
 * The egress *gating* (mode registry, proxy core) lives in
 * @agentproto/egress because that's a different concern (network-
 * boundary control). Egress imports from here.
 */

/** Function applied to the seed value before write. Receives the raw
 *  secret value (or empty string when `field` is omitted) plus an
 *  optional context bag the host populates. Returns the file body. */
export type SecretExposureWrap = (
  value: string,
  ctx?: SecretExposureWrapContext
) => string

/** Generic context passed to `wrap` callbacks. Hosts populate fields
 *  they have; wraps that don't care ignore the second arg entirely.
 *  Kept open-ended (string-keyed) so hosts can attach app-specific
 *  data without forcing a schema change here. */
export interface SecretExposureWrapContext {
  [key: string]: unknown
}

/** Inject the secret value as a process env var inside the runtime. */
export interface EnvExposure {
  kind: "env"
  /** Env var name as the runtime sees it. */
  name: string
  /** Field on the secret/connector settings whose value seeds the env.
   *  Required for env exposures — env vars don't have a `wrap` path. */
  field: string
}

/** Drop a file inside the runtime's filesystem before any process
 *  starts. Path uses `~` expansion against the runtime's exec user
 *  home (host-resolved). */
export interface FileExposure {
  kind: "file"
  /** Absolute path or `~`-relative path inside the runtime sandbox. */
  path: string
  /** Field on the secret/connector settings whose value seeds the file
   *  body. Omit when `wrap` produces synthetic content (e.g. claude's
   *  `.claude.json` migration flags don't depend on a token). */
  field?: string
  /** POSIX file mode. Default `0o600`. */
  mode?: number
  /** Transform applied before write — see SecretExposureWrap. */
  wrap?: SecretExposureWrap
}

/**
 * Mark this secret as eligible for substitution at the egress proxy.
 * Agents see only `$$SECRET[<placeholderName>]$$` placeholders; the
 * proxy substitutes the real value at the network boundary.
 *
 * The actual proxy + sigil regex + substitution engine live in
 * `@agentproto/egress` — this exposure variant just declares the
 * intent + the per-secret defaults the host install handler stamps.
 */
export interface EgressSubstituteExposure {
  kind: "egress-substitute"
  /** The token agents reference in `$$SECRET[NAME]$$`. By convention
   *  this matches the env-exposure name on the same secret, but it
   *  doesn't have to — placeholders and env vars are independent. */
  placeholderName: string
  /** Default value for the per-secret allowlist flag stamped at install
   *  time. UI may offer a per-install override. When false, the secret
   *  is declared egress-aware but rejected by the resolver until an
   *  admin opts in. */
  allowedByDefault: boolean
  /** Audit / UX hint — the providers this secret is *meant* for. NOT
   *  enforced at egress (proxy substitutes any matching placeholder
   *  regardless of upstream); the field exists so UIs can surface
   *  "this secret is for OpenAI" without parsing the slug. */
  intendedProviders?: string[]
}

/**
 * Discriminated union of all exposure mechanisms. Add new variants here
 * as new exposure surfaces are added (MCP-header, HTTP-bearer, etc.) —
 * each adds one variant, one switch case in consumers.
 */
export type SecretExposure =
  | EnvExposure
  | FileExposure
  | EgressSubstituteExposure

/** Type guard — convenient for filtering an exposures array by kind. */
export function isExposureKind<K extends SecretExposure["kind"]>(
  exposure: SecretExposure,
  kind: K
): exposure is Extract<SecretExposure, { kind: K }> {
  return exposure.kind === kind
}
