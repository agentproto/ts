/**
 * Egress provider allowlist — the set of upstream URLs the proxy is
 * willing to forward traffic to. Keeps the route from being a generic
 * "proxy anywhere" hole.
 *
 * Hosts pick their own subset and may extend with private upstreams.
 * Each entry is keyed by a stable provider id (`openai`, `anthropic`,
 * …) used in the egress URL: `${apiUrl}/egress/<providerId>/...`.
 *
 * `pathPrefix` lets entries that have a versioned root (`/v1` for
 * openai) match the SDK's default base URL convention — the agent's
 * SDK sends `${BASE_URL}/chat/completions` and the proxy resolves to
 * `${upstream}${pathPrefix}/chat/completions`.
 */

export interface EgressProvider {
  id: string
  /** Public origin (scheme + host). No trailing slash; no path. */
  upstream: string
  /** Path prefix appended after the provider id in the egress URL.
   *  e.g. `/v1` for openai so SDKs configured with
   *  `OPENAI_BASE_URL=${apiUrl}/egress/openai/v1` work natively. */
  pathPrefix?: string
  /** Header name SDKs use to send credentials. Information-only —
   *  substitution happens on whatever header the agent sends; this
   *  is for UI hints and audit grouping. */
  authHeader?: string
}

/**
 * The shipped allowlist. Hosts compose by spreading this + their own.
 * Kept narrow on purpose — the user-visible decision is "which providers
 * does my proxy accept", not "which providers does the SDK universe
 * support".
 */
export const COMMON_EGRESS_PROVIDERS: Record<string, EgressProvider> = {
  openai: {
    id: "openai",
    upstream: "https://api.openai.com",
    pathPrefix: "/v1",
    authHeader: "Authorization",
  },
  anthropic: {
    id: "anthropic",
    upstream: "https://api.anthropic.com",
    authHeader: "x-api-key",
  },
}

/** Convenience: build a registry from a base + extensions. */
export function composeEgressProviders(
  ...sources: Array<Record<string, EgressProvider>>
): Record<string, EgressProvider> {
  const out: Record<string, EgressProvider> = {}
  for (const src of sources) Object.assign(out, src)
  return out
}
