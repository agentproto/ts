/**
 * Two-hop discovery per the auth.md standard (AIP-50 §Discovery algorithm).
 *
 * Hop 1: GET {apiBase}/.well-known/oauth-protected-resource (PRM, RFC 8414)
 *   → extract authorization_servers[0] as authServerBase
 * Hop 2: GET {authServerBase}/.well-known/oauth-authorization-server (AS metadata)
 *   → extract token_endpoint + agent_auth block
 *
 * Callers MUST catch DiscoveryError and fall back to static manifest config —
 * discovery failures are common (server predates auth.md) and MUST NOT prevent
 * the PAT or other static flows from working.
 */

import { z } from "zod"
import type { DiscoveredEndpoints } from "./types.js"
import { fetchWithDeadline } from "./http.js"

export class DiscoveryError extends Error {
  readonly serverUrl: string
  constructor(message: string, serverUrl: string) {
    super(`DiscoveryError (${serverUrl}): ${message}`)
    this.name = "DiscoveryError"
    this.serverUrl = serverUrl
  }
}

// Discovery JSON is server-controlled, so it's validated rather than asserted.
// Everything is optional + `.loose()`: the document evolves, and the required
// fields are enforced explicitly below with precise DiscoveryError messages.
const prmSchema = z
  .object({
    resource: z.string().optional(),
    resource_name: z.string().optional(),
    authorization_servers: z.array(z.string()).optional(),
    scopes_supported: z.array(z.string()).optional(),
    bearer_methods_supported: z.array(z.string()).optional(),
  })
  .loose()

const asMetaSchema = z
  .object({
    issuer: z.string().optional(),
    token_endpoint: z.string().optional(),
    revocation_endpoint: z.string().optional(),
    grant_types_supported: z.array(z.string()).optional(),
    agent_auth: z
      .object({
        skill: z.string().optional(),
        identity_endpoint: z.string().optional(),
        claim_endpoint: z.string().optional(),
        events_endpoint: z.string().optional(),
        identity_types_supported: z.array(z.string()).optional(),
        identity_assertion: z
          .object({ assertion_types_supported: z.array(z.string()).optional() })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

type PRMShape = z.infer<typeof prmSchema>
type ASMetaShape = z.infer<typeof asMetaSchema>

export interface DiscoverOptions {
  /** Abort the discovery fetches (e.g. on user Ctrl-C). */
  signal?: AbortSignal
  /** Per-hop timeout. Defaults to DEFAULT_HTTP_TIMEOUT_MS. */
  timeoutMs?: number
}

export async function discoverEndpoints(
  apiBase: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredEndpoints> {
  const base = apiBase.replace(/\/$/, "")
  const fetchOpts = { signal: opts.signal }

  // Hop 1 — PRM
  const prmUrl = `${base}/.well-known/oauth-protected-resource`
  let prm: PRMShape
  try {
    const res = await fetchWithDeadline(prmUrl, fetchOpts, opts.timeoutMs)
    if (!res.ok) {
      throw new DiscoveryError(
        `PRM returned ${res.status} ${res.statusText}`,
        apiBase,
      )
    }
    prm = prmSchema.parse(await res.json())
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`PRM fetch failed: ${err}`, apiBase)
  }

  const authServerBase = prm.authorization_servers?.[0]?.replace(/\/$/, "")
  if (!authServerBase) {
    throw new DiscoveryError(
      "PRM missing authorization_servers[0]",
      apiBase,
    )
  }

  // Hop 2 — AS metadata
  const asUrl = `${authServerBase}/.well-known/oauth-authorization-server`
  let as: ASMetaShape
  try {
    const res = await fetchWithDeadline(asUrl, fetchOpts, opts.timeoutMs)
    if (!res.ok) {
      throw new DiscoveryError(
        `AS metadata returned ${res.status} ${res.statusText}`,
        apiBase,
      )
    }
    as = asMetaSchema.parse(await res.json())
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`AS metadata fetch failed: ${err}`, apiBase)
  }

  const tokenEndpoint = as.token_endpoint
  const identityEndpoint = as.agent_auth?.identity_endpoint
  if (!tokenEndpoint) {
    throw new DiscoveryError("AS metadata missing token_endpoint", apiBase)
  }
  if (!identityEndpoint) {
    throw new DiscoveryError(
      "AS metadata missing agent_auth.identity_endpoint",
      apiBase,
    )
  }

  return {
    resource: prm.resource ?? base,
    resourceName: prm.resource_name,
    authServerBase,
    tokenEndpoint,
    revocationEndpoint: as.revocation_endpoint,
    identityEndpoint,
    claimEndpoint: as.agent_auth?.claim_endpoint,
    identityTypesSupported: as.agent_auth?.identity_types_supported ?? [],
    grantTypesSupported: as.grant_types_supported ?? [],
  }
}
