/**
 * AIP-59 section 8 sub-session tokens, minted by the daemon for an imported
 * MCP server that speaks them (Bureau).
 *
 * The daemon reaches every imported MCP through ONE shared proxy connection,
 * and today it tells the server who is calling with a bare header
 * (`x-agentproto-caller-session`, `caller-scope.ts`). That header is spoofable
 * (review B2). For an import that opted in with `subsession: "aip-59"`, this
 * minter exchanges the device credential the import already carries for a
 * per-session token, which the guard then sends as `Agentproto-Subsession`
 * instead of the bare header.
 *
 * Tokens are cached per (alias, session) and re-minted within 60 s of expiry;
 * concurrent callers for one key share a single in-flight mint. No token, and
 * no `Authorization` value, is ever part of an error message or a log line.
 */

export interface SubsessionTarget {
  /** Origin of the import (no path); `/pair/subsessions` is appended. */
  baseUrl: string
  /** Headers the import already sends, including its `Authorization`. */
  headers: Record<string, string>
}

export interface SubsessionMinterOptions {
  /** undefined = this alias is not an `aip-59` import (no token). */
  resolve(alias: string): Promise<SubsessionTarget | undefined>
  fetch?: typeof fetch
  now?: () => number
  /** Requested lifetime; the server may clamp it. Default 3600. */
  ttlSeconds?: number
  /** Called after a successful mint; targets the link surface, not the token. */
  onMinted?(sessionId: string, target: SubsessionTarget): void
}

export interface SubsessionMinter {
  applies(alias: string): Promise<boolean>
  tokenFor(alias: string, sessionId: string): Promise<string>
  revokeSession(sessionId: string): Promise<void>
}

interface CachedToken {
  alias: string
  sessionId: string
  token: string
  expiresAtMs: number
  target: SubsessionTarget
}

const CACHE_MARGIN_MS = 60_000
const DEFAULT_TTL_SECONDS = 3600

const keyOf = (alias: string, sessionId: string): string => `${alias}\u0000${sessionId}`

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")

export function createSubsessionMinter(o: SubsessionMinterOptions): SubsessionMinter {
  const fetchImpl = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const ttlSeconds = o.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const cache = new Map<string, CachedToken>()
  const inFlight = new Map<string, Promise<string>>()

  async function mint(alias: string, sessionId: string, target: SubsessionTarget): Promise<string> {
    let res: Response
    try {
      res = await fetchImpl(`${trimBase(target.baseUrl)}/pair/subsessions`, {
        method: "POST",
        headers: { ...target.headers, "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ttlSeconds }),
      })
    } catch (err) {
      throw new Error(
        `sub-session mint for "${alias}" failed: request error (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (!res.ok) {
      throw new Error(`sub-session mint for "${alias}" failed: HTTP ${res.status}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new Error(`sub-session mint for "${alias}" failed: response is not JSON`)
    }
    const record = (body ?? {}) as Record<string, unknown>
    const token = record.token
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`sub-session mint for "${alias}" failed: response carries no token`)
    }
    const parsedExpiry = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + ttlSeconds * 1000
    cache.set(keyOf(alias, sessionId), { alias, sessionId, token, expiresAtMs, target })
    try {
      o.onMinted?.(sessionId, target)
    } catch {
      // A link-recording failure must never fail the call itself.
    }
    return token
  }

  return {
    async applies(alias) {
      return (await o.resolve(alias)) !== undefined
    },

    async tokenFor(alias, sessionId) {
      const key = keyOf(alias, sessionId)
      const cached = cache.get(key)
      if (cached && cached.expiresAtMs - now() > CACHE_MARGIN_MS) return cached.token
      const running = inFlight.get(key)
      if (running) return running
      const promise = (async () => {
        const target = await o.resolve(alias)
        if (!target) throw new Error(`sub-session mint for "${alias}" failed: not an AIP-59 import`)
        return mint(alias, sessionId, target)
      })()
      inFlight.set(key, promise)
      try {
        return await promise
      } finally {
        inFlight.delete(key)
      }
    },

    async revokeSession(sessionId) {
      const targets = new Map<string, SubsessionTarget>()
      for (const [key, entry] of cache) {
        if (entry.sessionId !== sessionId) continue
        targets.set(entry.alias, entry.target)
        cache.delete(key)
      }
      const failures: string[] = []
      for (const alias of targets.keys()) {
        const target = targets.get(alias)!
        try {
          await fetchImpl(
            `${trimBase(target.baseUrl)}/pair/subsessions/${encodeURIComponent(sessionId)}`,
            { method: "DELETE", headers: { ...target.headers } },
          )
        } catch {
          failures.push(alias)
        }
      }
      if (failures.length > 0) {
        throw new Error(`sub-session revoke for "${sessionId}" failed for: ${failures.join(", ")}`)
      }
    },
  }
}
