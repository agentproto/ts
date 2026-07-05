/**
 * Two-hop discovery per the auth.md standard (AIP-50 §Discovery algorithm),
 * with a second strategy for hosts that don't speak auth.md.
 *
 * Strategy 1 (OAuth PRM chain):
 *   Hop 1: GET {apiBase}/.well-known/oauth-protected-resource (PRM, RFC 8414)
 *     → extract authorization_servers[0] as authServerBase
 *   Hop 2: GET {authServerBase}/.well-known/oauth-authorization-server (AS metadata)
 *     → extract token_endpoint + agent_auth block
 *
 * Strategy 2 (agentproto-host.json), tried when strategy 1 fails:
 *   GET {apiBase}/.well-known/agentproto-host.json
 *     → extract device_authorization_endpoint + token_endpoint
 *
 * Callers MUST catch DiscoveryError and fall back to static manifest config —
 * discovery failures are common (server predates auth.md) and MUST NOT prevent
 * the PAT or other static flows from working.
 */

import { z } from "zod"
import type { DiscoveredEndpoints } from "./types.js"
import { fetchWithDeadline, assertSecureUrl } from "./http.js"

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
    device_authorization_endpoint: z.string().optional(),
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

const hostJsonSchema = z
  .object({
    device_authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    revocation_endpoint: z.string().optional(),
  })
  .loose()

type PRMShape = z.infer<typeof prmSchema>
type ASMetaShape = z.infer<typeof asMetaSchema>
type HostJsonShape = z.infer<typeof hostJsonSchema>

export interface DiscoverOptions {
  /** Abort the discovery fetches (e.g. on user Ctrl-C). */
  signal?: AbortSignal
  /** Per-hop timeout. Defaults to DEFAULT_HTTP_TIMEOUT_MS. */
  timeoutMs?: number
}

async function discoverViaPRM(
  base: string,
  fetchOpts: RequestInit,
  opts: DiscoverOptions,
): Promise<DiscoveredEndpoints> {
  // Hop 1 — PRM
  const prmUrl = `${base}/.well-known/oauth-protected-resource`
  let prm: PRMShape
  try {
    assertSecureUrl(prmUrl)
    const res = await fetchWithDeadline(prmUrl, fetchOpts, opts.timeoutMs)
    if (!res.ok) {
      throw new DiscoveryError(
        `PRM returned ${res.status} ${res.statusText}`,
        base,
      )
    }
    prm = prmSchema.parse(await res.json())
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`PRM fetch failed: ${err}`, base)
  }

  const authServerBase = prm.authorization_servers?.[0]?.replace(/\/$/, "")
  if (!authServerBase) {
    throw new DiscoveryError(
      "PRM missing authorization_servers[0]",
      base,
    )
  }

  // Hop 2 — AS metadata
  const asUrl = `${authServerBase}/.well-known/oauth-authorization-server`
  let as: ASMetaShape
  try {
    assertSecureUrl(asUrl)
    const res = await fetchWithDeadline(asUrl, fetchOpts, opts.timeoutMs)
    if (!res.ok) {
      throw new DiscoveryError(
        `AS metadata returned ${res.status} ${res.statusText}`,
        base,
      )
    }
    as = asMetaSchema.parse(await res.json())
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`AS metadata fetch failed: ${err}`, base)
  }

  const tokenEndpoint = as.token_endpoint
  const identityEndpoint = as.agent_auth?.identity_endpoint
  if (!tokenEndpoint) {
    throw new DiscoveryError("AS metadata missing token_endpoint", base)
  }
  if (!identityEndpoint) {
    throw new DiscoveryError(
      "AS metadata missing agent_auth.identity_endpoint",
      base,
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
    deviceAuthorizationEndpoint: as.device_authorization_endpoint,
    identityTypesSupported: as.agent_auth?.identity_types_supported ?? [],
    grantTypesSupported: as.grant_types_supported ?? [],
  }
}

async function discoverViaHostJson(
  base: string,
  fetchOpts: RequestInit,
  opts: DiscoverOptions,
): Promise<DiscoveredEndpoints> {
  const url = `${base}/.well-known/agentproto-host.json`
  let doc: HostJsonShape
  try {
    assertSecureUrl(url)
    const res = await fetchWithDeadline(url, fetchOpts, opts.timeoutMs)
    if (!res.ok) {
      throw new DiscoveryError(
        `agentproto-host.json returned ${res.status} ${res.statusText}`,
        base,
      )
    }
    doc = hostJsonSchema.parse(await res.json())
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`agentproto-host.json fetch failed: ${err}`, base)
  }

  if (!doc.token_endpoint) {
    throw new DiscoveryError(
      "agentproto-host.json missing token_endpoint",
      base,
    )
  }
  if (!doc.device_authorization_endpoint) {
    throw new DiscoveryError(
      "agentproto-host.json missing device_authorization_endpoint",
      base,
    )
  }

  return {
    resource: base,
    authServerBase: base,
    tokenEndpoint: doc.token_endpoint,
    revocationEndpoint: doc.revocation_endpoint,
    deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
    identityTypesSupported: [],
    grantTypesSupported: [],
  }
}

export async function discoverEndpoints(
  apiBase: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredEndpoints> {
  const base = apiBase.replace(/\/$/, "")
  // AIP-50 §Security: HTTPS only (loopback exempt for dev), and never follow
  // redirects on discovery — a 3xx is treated as a failure, not chased to a
  // potentially-rogue endpoint.
  const fetchOpts: RequestInit = {
    signal: opts.signal,
    redirect: "manual",
  }

  try {
    return await discoverViaPRM(base, fetchOpts, opts)
  } catch (prmErr) {
    // A caller-initiated abort is terminal — don't fire a second round of
    // requests on a signal that has already aborted (its "abort" event has
    // already fired once and a fresh listener on it will never see it again,
    // hanging the fallback forever).
    if (opts.signal?.aborted) throw prmErr
    // Second strategy: a host that doesn't speak the auth.md PRM chain may
    // still expose device-code endpoints via agentproto-host.json. If that
    // also fails, surface the ORIGINAL PRM error — it's almost always the
    // more informative one (host.json 404s are the common case).
    try {
      return await discoverViaHostJson(base, fetchOpts, opts)
    } catch {
      throw prmErr
    }
  }
}
