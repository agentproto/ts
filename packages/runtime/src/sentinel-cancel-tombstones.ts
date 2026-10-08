/**
 * Persisted cancel tombstones — the remote-deletion half of unwatching.
 *
 * Removing a local sentinel while the backing remote subscription is
 * unreachable used to orphan the remote (a best-effort `provider.cancel` whose
 * failure was swallowed). Now the intent to delete is recorded durably FIRST,
 * keyed by `provider + remoteId` — the identity of the remote resource, NOT the
 * (deterministic) MCP subscription id, so an immediate re-subscribe, which
 * provisions a new remote with a new id, is never touched by the old tombstone.
 * A sweep retries (with backoff) until the provider reports the remote gone
 * (`cancel` is idempotent: 404/204 both resolve).
 *
 * Only identifiers are persisted; any state field that looks like a secret or
 * route key is stripped from the stored handle.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { writeFileDurable } from "./durable-file.js"
import type { SentinelHandle, SentinelProviderHandle } from "./sentinel-providers/types.js"

export interface CancelTombstone {
  /** `provider|remoteId`. */
  key: string
  provider: string
  remoteId: string
  /** The handle with secrets stripped — enough for `provider.cancel`. */
  handle: SentinelHandle
  createdAt: number
  attempts: number
  nextAttemptAt: number
  lastAttemptAt?: number
  lastError?: string
}

export interface CancelResult {
  /** The provider confirmed the remote is gone (deleted or already absent). */
  converged: boolean
  tombstone?: CancelTombstone
}

export interface CancelTombstoneStore {
  /** Record the deletion intent durably, run `afterRecorded` (the caller drops
   *  its local record there, so delivery eligibility ends BEFORE any network
   *  call), attempt the remote delete, and remove the tombstone once the
   *  provider confirms. Rejects only when the intent could not be made
   *  durable — nothing local has been dropped yet at that point. */
  cancel(handle: SentinelHandle, afterRecorded?: () => void): Promise<CancelResult>
  /** Retry every tombstone whose backoff elapsed. */
  sweep(): Promise<{ attempted: number; converged: number; remaining: number }>
  list(): CancelTombstone[]
  has(provider: string, remoteId: string): boolean
}

export interface CancelTombstoneOptions {
  /** Omitted ⇒ in-memory only (tests). */
  filePath?: string
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** True when a live local sentinel currently owns this remote — the
   *  tombstone is then stale (the remote was adopted) and is dropped, not
   *  executed. */
  isRemoteInUse?: (provider: string, remoteId: string) => boolean
  nowMs?: () => number
  log?: (line: string) => void
  baseBackoffMs?: number
  maxBackoffMs?: number
}

export function defaultCancelTombstonePath(): string {
  return resolve(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "sentinel-cancel-tombstones.json")
}

const SECRETISH = /secret|token|key|password|credential|authorization/i

function stripSecrets(handle: SentinelHandle): SentinelHandle {
  const state: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(handle.state ?? {})) if (!SECRETISH.test(k)) state[k] = v
  return {
    provider: handle.provider,
    ...(handle.remoteId !== undefined ? { remoteId: handle.remoteId } : {}),
    ...(handle.cursor !== undefined ? { cursor: handle.cursor } : {}),
    ...(Object.keys(state).length > 0 ? { state } : {}),
  }
}

const keyOf = (provider: string, remoteId: string): string => `${provider}|${remoteId}`

function load(filePath: string): CancelTombstone[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { tombstones?: unknown }
    if (!Array.isArray(parsed.tombstones)) return []
    return parsed.tombstones.filter(
      (t): t is CancelTombstone => typeof t === "object" && t !== null && typeof (t as CancelTombstone).key === "string",
    )
  } catch {
    return []
  }
}

export function createCancelTombstoneStore(opts: CancelTombstoneOptions): CancelTombstoneStore {
  const nowMs = opts.nowMs ?? Date.now
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const base = opts.baseBackoffMs ?? 30_000
  const max = opts.maxBackoffMs ?? 60 * 60 * 1000
  const rows = new Map<string, CancelTombstone>()
  if (opts.filePath) for (const t of load(opts.filePath)) rows.set(t.key, t)

  let writeTail: Promise<void> = Promise.resolve()
  function persist(): Promise<void> {
    if (!opts.filePath) return Promise.resolve()
    const filePath = opts.filePath
    const run = (): Promise<void> =>
      writeFileDurable(filePath, JSON.stringify({ version: 1, tombstones: [...rows.values()] }, null, 2))
    const next = writeTail.then(run, run)
    writeTail = next.catch(() => undefined)
    return next
  }

  const inFlight = new Map<string, Promise<boolean>>()

  async function attempt(t: CancelTombstone, explicit = false): Promise<boolean> {
    const running = inFlight.get(t.key)
    if (running) return running
    const p = (async (): Promise<boolean> => {
      if (!explicit && opts.isRemoteInUse?.(t.provider, t.remoteId)) {
        rows.delete(t.key)
        await persist().catch(err => log(`[sentinel-tombstones] persist failed: ${String(err)}`))
        return true
      }
      const provider = await opts.resolveProvider(t.provider)
      let error: string | undefined
      if (!provider) error = `unknown sentinel provider "${t.provider}"`
      else {
        try {
          await provider.cancel(t.handle)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
      }
      const live = rows.get(t.key)
      if (error === undefined) {
        if (live) rows.delete(t.key)
        await persist().catch(err => log(`[sentinel-tombstones] persist failed: ${String(err)}`))
        return true
      }
      if (live) {
        live.attempts += 1
        live.lastAttemptAt = nowMs()
        live.lastError = error.slice(0, 300)
        live.nextAttemptAt = nowMs() + Math.min(max, base * 2 ** Math.min(live.attempts, 20))
        await persist().catch(err => log(`[sentinel-tombstones] persist failed: ${String(err)}`))
      }
      return false
    })().finally(() => inFlight.delete(t.key))
    inFlight.set(t.key, p)
    return p
  }

  return {
    async cancel(handle: SentinelHandle, afterRecorded?: () => void): Promise<CancelResult> {
      const provider = await opts.resolveProvider(handle.provider)
      if (!handle.remoteId || !provider?.exclusiveRemote) {
        // No remote id, or a provider whose remote is shared between handles:
        // nothing keyed to retry against — best-effort, as before.
        afterRecorded?.()
        let converged = true
        try {
          await provider?.cancel(handle)
        } catch {
          converged = false
        }
        return { converged }
      }
      const key = keyOf(handle.provider, handle.remoteId)
      let t = rows.get(key)
      if (!t) {
        const now = nowMs()
        t = {
          key,
          provider: handle.provider,
          remoteId: handle.remoteId,
          handle: stripSecrets(handle),
          createdAt: now,
          attempts: 0,
          nextAttemptAt: now,
        }
        rows.set(key, t)
        try {
          await persist()
        } catch (err) {
          rows.delete(key)
          throw err
        }
      }
      afterRecorded?.()
      const converged = await attempt(t, true)
      const remaining = rows.get(key)
      return { converged, ...(remaining ? { tombstone: remaining } : {}) }
    },

    async sweep(): Promise<{ attempted: number; converged: number; remaining: number }> {
      const now = nowMs()
      const due = [...rows.values()].filter(t => t.nextAttemptAt <= now)
      let converged = 0
      for (const t of due) if (await attempt(t)) converged++
      return { attempted: due.length, converged, remaining: rows.size }
    },

    list: () => [...rows.values()],
    has: (provider, remoteId) => rows.has(keyOf(provider, remoteId)),
  }
}
