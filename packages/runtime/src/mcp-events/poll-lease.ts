/**
 * Watch leases behind `events/poll`.
 *
 * `events/poll` is self-contained: it needs no prior `events/subscribe` and the
 * server keeps no per-client protocol state. The first poll of a
 * `(name, arguments)` key takes a lease: it opens ONE provider watch shared by
 * every poller of that key and feeds the poll journal from it. A lease that
 * nobody polls for `idleTtlMs` is released (the provider watch is cancelled),
 * so abandoned keys never leave an orphan watch behind.
 *
 * An open `events/stream` RETAINS its lease (`retain`): a retained lease is never
 * swept, since `lastUsedAt` only moves on `acquire` and a quiet stream would
 * otherwise lose its watch after `idleTtlMs`. The idle clock restarts when the
 * last hold is released.
 *
 * The provider's own cursor lives in the lease (memory); the journal is what
 * clients replay from. After a restart the lease is gone: the next poll opens
 * a new watch and the journal records a gap, so older cursors read as
 * `truncated` instead of silently skipping events.
 */

import type { SentinelEvent, SentinelHandle, SentinelProviderHandle, SentinelSpec } from "@agentproto/sentinel"
import { deliveryPreferenceFor } from "@agentproto/sentinel"
import type { ArgumentsResult } from "./events-registry.js"
import type { JournalEvent, PollJournal } from "./poll-journal.js"

export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_PUMP_INTERVAL_MS = 15 * 1000
export const DEFAULT_MAX_LEASES = 64
/** How often the background timer purges the journal (expired entries, unfed journals). */
export const DEFAULT_PURGE_INTERVAL_MS = 10 * 60 * 1000

type Mapped = Extract<ArgumentsResult, { ok: true }>

export interface AcquireInput {
  key: string
  /** Wire event name; only events of this type reach the journal. */
  name: string
  mapped: Mapped
}

export interface PollLeaseManagerOptions {
  journal: PollJournal
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  idleTtlMs?: number
  /** Minimum spacing between two provider polls of one lease. */
  pumpIntervalMs?: number
  maxLeases?: number
  /** Spacing, on `now`, between two background journal purges. Default 10 min. */
  purgeIntervalMs?: number
  now?: () => number
  /** Convert a provider event to the wire shape (`toMcpEvent` minus the cursor). */
  toEvent: (event: SentinelEvent) => JournalEvent
  /** Run the background sweep/pump timer (disable in tests). Default true. */
  background?: boolean
}

/** Typed failure the adapter maps to the official JSON-RPC codes. */
export class PollLeaseError extends Error {
  constructor(
    readonly kind: "unsupported" | "exhausted" | "backing",
    message: string,
    /** The ceiling that was hit (`exhausted` only). */
    readonly max?: number,
  ) {
    super(message)
    this.name = "PollLeaseError"
  }
}

interface Lease {
  key: string
  name: string
  provider: SentinelProviderHandle
  handle: SentinelHandle
  lastUsedAt: number
  lastPumpAt: number
  chain: Promise<unknown>
}

/** Category of a failed provider pull, safe to put on the wire (never the provider's raw message). */
export type PumpFailureReason = "upstream_poll_failed"

export interface PollLeaseManager {
  /** Take (or reuse) the lease for `input.key`, then pull any new provider events into the journal. */
  acquire(input: AcquireInput): Promise<{ created: boolean }>
  /**
   * Hold the lease of `key` open: `sweep` never releases a held lease. Returns the release function (idempotent);
   * the idle TTL counts from the moment the last hold is released.
   */
  retain(key: string): () => void
  /** Be told when a provider pull for `key` fails (the pump keeps retrying). Returns the unsubscribe function. */
  onPumpError(key: string, listener: (reason: PumpFailureReason) => void): () => void
  /** Release leases idle for longer than the TTL. Returns the keys released. */
  sweep(): Promise<string[]>
  isActive(key: string): boolean
  size(): number
  /** Stop the timer and cancel every provider watch. */
  stop(): Promise<void>
  /** Milliseconds the client should wait before the next poll when nothing is pending. */
  readonly nextPollMs: number
}

export function createPollLeaseManager(opts: PollLeaseManagerOptions): PollLeaseManager {
  const idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const pumpIntervalMs = opts.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS
  const maxLeases = opts.maxLeases ?? DEFAULT_MAX_LEASES
  const purgeIntervalMs = opts.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS
  const now = opts.now ?? Date.now
  const leases = new Map<string, Lease>()
  const opening = new Map<string, Promise<Lease>>()
  const holds = new Map<string, number>()
  const pumpErrorListeners = new Map<string, Set<(reason: PumpFailureReason) => void>>()

  function reportPumpError(key: string): void {
    for (const listener of [...(pumpErrorListeners.get(key) ?? [])]) {
      try {
        listener("upstream_poll_failed")
      } catch {
        // A listener must never break the pump.
      }
    }
  }

  async function open(input: AcquireInput): Promise<Lease> {
    const provider = await opts.resolveProvider(input.mapped.providerSlug)
    if (!provider) throw new PollLeaseError("unsupported", `sentinel provider "${input.mapped.providerSlug}" is not available`)
    if (!provider.capabilities.poll || typeof provider.poll !== "function") {
      throw new PollLeaseError("unsupported", `provider "${input.mapped.providerSlug}" cannot be polled`)
    }
    // The spec's target is required by the type but never read: no sentinel row is
    // stored and no delivery pipeline runs, the journal is fed by `pump` below.
    const spec: SentinelSpec = {
      match: input.mapped.matchClauses,
      until: { kind: "never" },
      target: { kind: "routine", routineId: "mcp-events-poll" },
      provider: input.mapped.providerSlug,
    }
    let handle: SentinelHandle
    try {
      handle = await provider.create(spec, deliveryPreferenceFor(provider, pumpIntervalMs))
    } catch (err) {
      throw new PollLeaseError("backing", err instanceof Error ? err.message : String(err))
    }
    const t = now()
    const lease: Lease = { key: input.key, name: input.name, provider, handle, lastUsedAt: t, lastPumpAt: 0, chain: Promise.resolve() }
    opts.journal.markGap(input.key)
    leases.set(input.key, lease)
    return lease
  }

  /** Pull the provider's new events into the journal, one pump at a time per lease. */
  function pump(lease: Lease, force: boolean): Promise<void> {
    const run = lease.chain.then(async () => {
      if (!force && now() - lease.lastPumpAt < pumpIntervalMs) return
      lease.lastPumpAt = now()
      try {
        const result = await lease.provider.poll!(lease.handle, 100)
        const events = result.events.filter(e => e.type === lease.name).map(opts.toEvent)
        opts.journal.append(lease.key, events)
        lease.handle = { ...lease.handle, cursor: result.cursor }
        await lease.provider.ack?.(lease.handle, result.cursor)
      } catch {
        // A failing provider poll is retried on the next pump; the journal keeps what it has. Open streams are told.
        reportPumpError(lease.key)
      }
    })
    lease.chain = run.catch(() => undefined)
    return run
  }

  async function release(lease: Lease): Promise<void> {
    leases.delete(lease.key)
    try {
      await lease.provider.cancel(lease.handle)
    } catch {
      // Best effort: a stuck provider-side watch must not strand the release.
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let lastPurgeAt = now()
  if (opts.background !== false) {
    timer = setInterval(() => {
      void (async () => {
        await manager.sweep()
        await Promise.all([...leases.values()].map(l => pump(l, false)))
        // Without this the journal is only purged at boot: an unfed journal would sit on disk until a restart.
        if (now() - lastPurgeAt >= purgeIntervalMs) {
          lastPurgeAt = now()
          opts.journal.purge(key => manager.isActive(key))
        }
      })().catch(() => undefined)
    }, pumpIntervalMs)
    timer.unref?.()
  }

  const manager: PollLeaseManager = {
    nextPollMs: pumpIntervalMs,

    async acquire(input) {
      let lease = leases.get(input.key)
      let created = false
      if (!lease) {
        if (leases.size + opening.size >= maxLeases) {
          throw new PollLeaseError("exhausted", `too many concurrent poll watches (max ${maxLeases})`, maxLeases)
        }
        let pending = opening.get(input.key)
        if (!pending) {
          pending = open(input).finally(() => opening.delete(input.key))
          opening.set(input.key, pending)
        }
        lease = await pending
        created = true
      }
      lease.lastUsedAt = now()
      // The first pump of a fresh watch is the baseline; later pumps are rate-limited.
      await pump(lease, created)
      return { created }
    },

    retain(key) {
      holds.set(key, (holds.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (holds.get(key) ?? 1) - 1
        if (left > 0) {
          holds.set(key, left)
          return
        }
        holds.delete(key)
        const lease = leases.get(key)
        if (lease) lease.lastUsedAt = now()
      }
    },

    onPumpError(key, listener) {
      let set = pumpErrorListeners.get(key)
      if (!set) {
        set = new Set()
        pumpErrorListeners.set(key, set)
      }
      set.add(listener)
      return () => {
        const current = pumpErrorListeners.get(key)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) pumpErrorListeners.delete(key)
      }
    },

    async sweep() {
      const cutoff = now() - idleTtlMs
      const released: string[] = []
      for (const lease of [...leases.values()]) {
        if ((holds.get(lease.key) ?? 0) > 0) continue
        if (lease.lastUsedAt < cutoff) {
          await release(lease)
          released.push(lease.key)
        }
      }
      return released
    },

    isActive: key => leases.has(key) || opening.has(key),
    size: () => leases.size,

    async stop() {
      if (timer) clearInterval(timer)
      await Promise.all([...leases.values()].map(release))
    },
  }
  return manager
}
