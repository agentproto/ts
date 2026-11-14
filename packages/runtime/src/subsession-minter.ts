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

import type { SessionEventBus } from "./session-event-bus.js"
import { isRetired } from "./session-retirement.js"
import type { SessionDescriptor } from "./sessions.js"

export interface SubsessionTarget {
  /** Origin of the import (no path); `/pair/subsessions` is appended. */
  baseUrl: string
  /** Headers the import already sends, including its `Authorization`. */
  headers: Record<string, string>
  /**
   * Canonical cache identity for this target. The gateway reaches one import
   * by alias (`mcp_imported_call`) and by import id (`/mcp/imported/<id>`);
   * both must share ONE token per session. Defaults to the caller-supplied
   * alias when absent.
   */
  key?: string
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
  /**
   * Lets a session that exited but was resumed in place (same id) mint again.
   * Synchronous and idempotent; the next `tokenFor` mints a fresh token, after
   * any server-side DELETE still owed for the id has been settled.
   */
  reinstateSession(sessionId: string): void
}

interface PendingDelete {
  alias: string
  sessionId: string
  target: SubsessionTarget
}

/** A mint that straddled a revoke and a reinstate: its token is dropped, the caller mints again. */
class StaleMint extends Error {}

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
  const inFlight = new Map<string, { promise: Promise<string>; epoch: number }>()
  /** Sessions already revoked: a mint that lands after the revoke is deleted, never cached. */
  const revoked = new Set<string>()
  /** Bumped by every revoke, so a mint can tell that a revoke happened while it was in flight. */
  const epochs = new Map<string, number>()
  /** Revocations the server did not confirm, retried on the next revokeSession call. */
  const pendingDeletes = new Map<string, PendingDelete>()
  /**
   * DELETEs on the wire, per session id. The server deletes by session id, so a
   * DELETE landing after a fresh POST would kill the new token: a mint waits
   * for these (and for `pendingDeletes`) before it posts.
   */
  const deleting = new Map<string, Set<Promise<boolean>>>()

  const epochOf = (sessionId: string): number => epochs.get(sessionId) ?? 0

  function deleteTracked(key: string, item: PendingDelete): Promise<boolean> {
    let run!: Promise<boolean>
    run = (async (): Promise<boolean> => {
      let ok = false
      try {
        ok = await deleteOnServer(item.alias, item.sessionId, item.target)
        // Kept for the next call: a token the server still honours is never forgotten.
        if (!ok) pendingDeletes.set(key, item)
        return ok
      } finally {
        const set = deleting.get(item.sessionId)
        set?.delete(run)
        if (set && set.size === 0) deleting.delete(item.sessionId)
      }
    })()
    const set = deleting.get(item.sessionId) ?? new Set<Promise<boolean>>()
    set.add(run)
    deleting.set(item.sessionId, set)
    return run
  }

  async function settleDeletes(alias: string, sessionId: string): Promise<void> {
    for (;;) {
      const live = deleting.get(sessionId)
      if (live && live.size > 0) {
        await Promise.all([...live])
        continue
      }
      const owed = [...pendingDeletes].filter(([, item]) => item.sessionId === sessionId)
      if (owed.length === 0) return
      let failed = false
      for (const [key, item] of owed) {
        pendingDeletes.delete(key)
        if (!(await deleteTracked(key, item))) failed = true
      }
      if (failed) {
        throw new Error(
          `sub-session mint for "${alias}" failed: revoking the previous token of this session is still pending (will retry)`,
        )
      }
    }
  }

  async function deleteOnServer(alias: string, sessionId: string, target: SubsessionTarget): Promise<boolean> {
    try {
      const res = await fetchImpl(
        `${trimBase(target.baseUrl)}/pair/subsessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers: { ...target.headers } },
      )
      // 404: the server no longer knows the session, which is the goal.
      return res.ok || res.status === 404
    } catch {
      return false
    }
  }

  async function mint(alias: string, sessionId: string, target: SubsessionTarget): Promise<string> {
    const epoch = epochOf(sessionId)
    await settleDeletes(alias, sessionId)
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
    if (revoked.has(sessionId)) {
      // The session ended while this mint was in flight: do not keep the
      // token, revoke it on the server too.
      await deleteTracked(keyOf(target.key ?? alias, sessionId), { alias, sessionId, target })
      throw new Error(`sub-session mint for "${alias}" failed: the session ended`)
    }
    // Revoked and reinstated while this POST was out: a DELETE may have been
    // processed after it, so the token cannot be trusted. Drop it, mint again.
    if (epochOf(sessionId) !== epoch) throw new StaleMint()
    cache.set(keyOf(target.key ?? alias, sessionId), { alias, sessionId, token, expiresAtMs, target })
    try {
      o.onMinted?.(sessionId, target)
    } catch {
      // A link-recording failure must never fail the call itself.
    }
    return token
  }

  async function resolveToken(alias: string, sessionId: string): Promise<string> {
    if (revoked.has(sessionId)) {
      throw new Error(`sub-session mint for "${alias}" failed: the session ended`)
    }
    // Fast path for a connection that always names the import the same way.
    const localKey = keyOf(alias, sessionId)
    const localCached = cache.get(localKey)
    if (localCached && localCached.expiresAtMs - now() > CACHE_MARGIN_MS) return localCached.token
    const target = await o.resolve(alias)
    if (!target) throw new Error(`sub-session mint for "${alias}" failed: not an AIP-59 import`)
    // Alias and import id are two spellings of the SAME import: resolve both
    // to one canonical key so a session gets ONE token whichever path calls.
    const key = keyOf(target.key ?? alias, sessionId)
    const cached = cache.get(key)
    if (cached && cached.expiresAtMs - now() > CACHE_MARGIN_MS) {
      cache.set(localKey, cached)
      return cached.token
    }
    const running = inFlight.get(key)
    if (running && running.epoch === epochOf(sessionId)) return running.promise
    const entry = { promise: mint(alias, sessionId, target), epoch: epochOf(sessionId) }
    inFlight.set(key, entry)
    try {
      return await entry.promise
    } finally {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    }
  }

  return {
    async applies(alias) {
      return (await o.resolve(alias)) !== undefined
    },

    async tokenFor(alias, sessionId) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await resolveToken(alias, sessionId)
        } catch (err) {
          if (!(err instanceof StaleMint)) throw err
          if (attempt >= 2) {
            throw new Error(`sub-session mint for "${alias}" failed: the session was revoked while minting`)
          }
        }
      }
    },

    reinstateSession(sessionId) {
      revoked.delete(sessionId)
    },

    async revokeSession(sessionId) {
      revoked.add(sessionId)
      epochs.set(sessionId, epochOf(sessionId) + 1)
      // Alias and import id both cache the same token under two keys. A
      // revoke must still send exactly ONE DELETE per (server, session), so
      // dedupe by the server target rather than by cache key.
      const toDelete = new Map<string, PendingDelete>()
      const queuedTargets = new Set<string>()
      const queue = (key: string, item: PendingDelete): void => {
        const targetKey = `${trimBase(item.target.baseUrl)}\u0000${item.sessionId}`
        if (queuedTargets.has(targetKey)) return
        queuedTargets.add(targetKey)
        toDelete.set(key, item)
      }
      for (const [key, item] of pendingDeletes) queue(key, item)
      pendingDeletes.clear()
      for (const [key, entry] of cache) {
        if (entry.sessionId !== sessionId) continue
        queue(key, { alias: entry.alias, sessionId, target: entry.target })
        cache.delete(key)
      }
      // All DELETEs are registered before the first await, so a mint for a
      // reinstated session sees every one of them.
      const results = await Promise.all(
        [...toDelete].map(async ([key, item]) => ({ item, ok: await deleteTracked(key, item) })),
      )
      const failures = results.filter(r => !r.ok).map(r => `${r.item.alias}/${r.item.sessionId}`)
      if (failures.length > 0) {
        throw new Error(`sub-session revoke failed for: ${failures.join(", ")} (will retry)`)
      }
    },
  }
}

/**
 * Ties the minter to the session lifecycle: tokens are revoked when a session
 * exits, and a session that is revived in place (same id, `session:resumed`) is
 * reinstated so it can mint again. A retired or unknown id is never reinstated.
 */
export function wireSubsessionLifecycle(o: {
  sessionEvents: Pick<SessionEventBus, "on">
  registry: { get(id: string): Pick<SessionDescriptor, "archived" | "endedReason" | "continuedTo" | "retiredAt"> | undefined }
  subsessions: Pick<SubsessionMinter, "revokeSession" | "reinstateSession">
  /**
   * True while the session holds an approval (pending, or approved and not
   * consumed). Its revoke is then deferred: the revoke closes the Bureau tabs
   * the token owns, and the approval card lives in one of them. The deferred
   * revoke runs when the approval is decided-as-denied, consumed or expired and
   * nothing else is held. Omitted ⇒ revoke at exit, as before.
   */
  holdsApproval?: (sessionId: string) => boolean
  /** Looks up the approval's requester to find which session to re-check. */
  approvalSession?: (approvalId: string) => string | undefined
}): void {
  const revoke = (sessionId: string): void => {
    // A revocation failure never throws into the exit path.
    void o.subsessions.revokeSession(sessionId).catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[subsessions] revoke for ${sessionId} failed: ${message}`)
    })
  }
  /** Exited sessions whose revoke waits on an approval. */
  const deferred = new Set<string>()
  o.sessionEvents.on("session:exited", ev => {
    if (o.holdsApproval?.(ev.sessionId) === true) {
      deferred.add(ev.sessionId)
      return
    }
    revoke(ev.sessionId)
  })
  const settle = (approvalId: string): void => {
    const sessionId = o.approvalSession?.(approvalId)
    if (sessionId === undefined || !deferred.has(sessionId)) return
    if (o.holdsApproval?.(sessionId) === true) return
    deferred.delete(sessionId)
    revoke(sessionId)
  }
  o.sessionEvents.on("approval:decided", ev => {
    // An approval is released by `approval:consumed`; a denial ends it now.
    if (ev.decision === "denied") settle(ev.approvalId)
  })
  o.sessionEvents.on("approval:consumed", ev => settle(ev.approvalId))
  o.sessionEvents.on("approval:expired", ev => settle(ev.approvalId))
  o.sessionEvents.on("session:resumed", ev => {
    deferred.delete(ev.sessionId)
    const desc = o.registry.get(ev.sessionId)
    if (!desc || isRetired(desc)) return
    o.subsessions.reinstateSession(ev.sessionId)
  })
}
