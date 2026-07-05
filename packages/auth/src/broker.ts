/**
 * CredentialBroker — resolve ready-to-use auth headers for a `<providerId>`
 * or `<providerId>/<account>` path, auto-refreshing via the flow engine when
 * the stored credential is missing, expired, or not directly usable.
 *
 * Agent.pw-parity API: callers ask for headers by path and never touch
 * tokens, flows, or the underlying store directly.
 */

import { runAuthFlow } from "./run-flow.js"
import { resolveStoreRef } from "./store/resolve-ref.js"
import type { CredentialStore, StoredCredential } from "./store/types.js"
import type { AuthProviderHandle } from "./types.js"

/** Refresh this long before the actual expiry, so a credential that's about
 *  to expire mid-request gets renewed proactively instead of failing. */
const EXPIRY_SKEW_MS = 60_000

export interface CredentialBrokerOptions {
  /** Backend to read cached credentials from and persist refreshed ones to. */
  store: CredentialStore
  /** Provider lookup — pass `getAuthProvider` from the registry, or a custom
   *  resolver (e.g. scoped to a single host's providers). */
  getProvider: (id: string) => AuthProviderHandle | undefined
}

interface ParsedPath {
  providerId: string
  account?: string
}

/** Split `"<providerId>"` or `"<providerId>/<account>"` on the first `/`. */
function parsePath(path: string): ParsedPath {
  const slash = path.indexOf("/")
  if (slash === -1) return { providerId: path }
  return { providerId: path.slice(0, slash), account: path.slice(slash + 1) }
}

/** `expiresAt` in the future (past the refresh skew), or absent entirely. A
 *  malformed `expiresAt` is treated as expired — refresh rather than risk
 *  serving a header that a downstream API will reject. */
function isFresh(cred: StoredCredential): boolean {
  if (!cred.expiresAt) return true
  const expiresAtMs = Date.parse(cred.expiresAt)
  if (Number.isNaN(expiresAtMs)) return false
  return expiresAtMs - EXPIRY_SKEW_MS > Date.now()
}

/** Header map for a credential usable as a bearer token directly, or
 *  `undefined` when it isn't. `assertion` is never bearer-usable — it must be
 *  exchanged by a flow engine first — so it always falls through to
 *  `runAuthFlow`. */
function bearerHeaders(
  value: string,
  kind: StoredCredential["kind"],
): Record<string, string> | undefined {
  if (kind === "pat" || kind === "oat") {
    return { Authorization: `Bearer ${value}` }
  }
  return undefined
}

export class CredentialBroker {
  private readonly store: CredentialStore
  private readonly getProvider: (id: string) => AuthProviderHandle | undefined

  constructor(opts: CredentialBrokerOptions) {
    this.store = opts.store
    this.getProvider = opts.getProvider
  }

  async resolveHeaders(o: {
    path: string
    server?: string
    signal?: AbortSignal
  }): Promise<Record<string, string>> {
    const { providerId, account } = parsePath(o.path)
    const provider = this.getProvider(providerId)
    if (!provider) {
      throw new Error(`CredentialBroker: unknown auth provider "${providerId}"`)
    }

    const server = o.server ?? provider.apiBase
    const ref = resolveStoreRef(provider.auth.tokenStore, server)
    if (account !== undefined) ref.account = account

    const stored = await this.store.read(ref)
    if (stored && isFresh(stored)) {
      const headers = bearerHeaders(stored.value, stored.kind)
      if (headers) return headers
    }

    const result = await runAuthFlow(provider, {
      server,
      store: this.store,
      signal: o.signal,
    })
    const headers =
      result.accessToken !== undefined
        ? bearerHeaders(result.accessToken, result.tokenKind)
        : undefined
    if (!headers) {
      throw new Error(
        `CredentialBroker: auth flow for "${providerId}" produced no usable access token`,
      )
    }
    return headers
  }
}
