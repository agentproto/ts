/**
 * ReactionRunner: durable execution of action hook reactions over the receipt
 * store.
 *
 * The runner owns no durable state of its own. Every decision is taken from a
 * receipt transition, and the store is the only thing that persists. A live
 * event creates a `pending` receipt, the `running` transition is durable before
 * any target runs, and boot reconciliation replays only the receipts whose
 * target declares itself idempotent.
 *
 * Containment matches the workspace brain subscriber: a bus handler never
 * throws into the bus, a failed store write never starts a target, and boot
 * reconciliation resolves even when a trigger check throws.
 */

import type { SessionEvent, SessionEventBus, SessionEventType } from "../session-event-bus.js"
import type { ReactionReceipt, ReactionReceiptStore } from "./receipt-store.js"
import {
  ReceiptTransitionError,
  buildReactionReceiptKey,
} from "./receipt-store.js"
import { runInReactionContext } from "./reaction-context.js"

// ── Types ─────────────────────────────────────────────────────────────

export interface ReactionTargetInput {
  receiptKey: string
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
  reactionDepth: number
  causedByEventId?: string
}

export interface ReactionTargetOutcome {
  ok: boolean
  outcomeRef?: string
  retryable?: boolean
  error?: string
}

export interface ReactionTarget {
  readonly actionId: string
  /** true: re-running the same occurrence is safe because the target dedupes by its own durable ledger. */
  readonly idempotent: boolean
  run(input: ReactionTargetInput): Promise<ReactionTargetOutcome>
}

export interface ReactionBinding {
  bindingId: string
  /** A SessionEvent type, for example "agentproto:session-completed". */
  event: string
  actionId: string
  configRevision: string
  maxAttempts: number
  /** Depth stamped on the receipt (0 for a reaction to a root event). */
  reactionDepth: number
  /**
   * Optional causation of the incoming event. A finite depth replaces the
   * static `reactionDepth` for the inserted receipt and the cap check; a
   * throw is logged and treated as undefined.
   */
  causation?(event: SessionEvent): { reactionDepth: number; causedByEventId?: string } | undefined
  target: ReactionTarget
  /** The AIP-71 occurrence id of this event for this binding, or undefined to ignore the event. */
  occurrenceIdOf(event: SessionEvent): string | undefined
  /**
   * Optional filter evaluated BEFORE any receipt exists: false (or a throw,
   * which is logged) means "this binding does not apply to this event", no
   * receipt is created. Omitted means applies. Live events only, never
   * consulted at boot reconciliation.
   */
  shouldHandle?(event: SessionEvent): boolean | Promise<boolean>
  /**
   * Boot reconciliation only: is the trigger of a still `pending` receipt
   * valid? Omitted means valid. false marks the receipt dead with reason
   * "stale_trigger" and never runs it.
   */
  isTriggerValid?(receipt: ReactionReceipt): boolean | Promise<boolean>
}

export interface ReactionRunnerOptions {
  bus: SessionEventBus
  store: ReactionReceiptStore
  bindings: readonly ReactionBinding[]
  /** Default Date.now. */
  nowMs?: () => number
  /** Default 4. */
  maxReactionDepth?: number
  /** Default 4. */
  maxConcurrent?: number
  /** Default min(30_000 * 2 ** (attempt - 1), 600_000), deterministic, no jitter. */
  backoffMs?: (attempt: number) => number
  /** Default 30_000: period of the retry/sweep tick started by start(). */
  retryIntervalMs?: number
  /** Injectable for tests. */
  setInterval?: typeof setInterval
  /** Injectable for tests. */
  clearInterval?: typeof clearInterval
  /** Default console.warn; prefix "[reaction-runner]". */
  log?: (line: string) => void
  /** Default console.info; one line per terminal transition, separate from `log`. */
  trace?: (line: string) => void
}

export interface ReactionRunnerStatus {
  bindingId: string
  pending: number
  running: number
  failed: number
  dead: number
  lastError?: string
}

export interface ReactionBindingHealth {
  bindingId: string
  event: string
  counts: { pending: number; running: number; done: number; failed: number; dead: number }
  /** Age in ms (now minus createdAt) of the oldest receipt that is pending or failed; undefined when none. */
  oldestQueuedAgeMs?: number
  /** completedAt minus startedAt over the retained done receipts of this binding; undefined when there are none. */
  latencyMs?: { count: number; p50: number; p95: number; max: number }
  /** Highest reactionDepth over the retained receipts of this binding. */
  maxDepth: number
  /** Sum of (attempt - 1) over the retained receipts with attempt >= 1. */
  retries: number
  /** Dead receipts grouped by their lastError (the dead reason, for example recursion_cap, max_attempts, stale_trigger, age_out). */
  deadReasons: Record<string, number>
  lastError?: string
  /** Events this binding's shouldHandle rejected since the process started (memory only, resets at boot). */
  skipped: number
}

export interface ReactionHealth {
  generatedAt: number
  started: boolean
  maxReactionDepth: number
  maxConcurrent: number
  bindings: ReactionBindingHealth[]
  /** Retained receipts whose binding is not live any more (a routine disabled or deleted), grouped by binding id. */
  orphans: Array<{ bindingId: string; counts: { pending: number; running: number; done: number; failed: number; dead: number } }>
  totals: { receipts: number; pending: number; running: number; done: number; failed: number; dead: number }
}

export interface ReactionRunner {
  /** Idempotent: subscribe each binding's event on the bus and start the retry tick. */
  start(): void
  /** Idempotent: unsubscribe and clear the tick; never throws. */
  stop(): void
  handleEvent(event: SessionEvent, occurrenceId: string): Promise<void>
  /** Re-run `failed` receipts whose nextAttemptAt is due, then store.sweep(). */
  retryDue(): Promise<void>
  reconcileOnBoot(): Promise<void>
  /** Swap the live binding set. A run already in flight keeps the binding it started with. */
  replaceBindings(next: readonly ReactionBinding[]): void
  status(): ReactionRunnerStatus[]
  /** Synchronous, read-only health read model over the store rows and skip counters. */
  health(): ReactionHealth
}

// ── Constants ─────────────────────────────────────────────────────────

const LOG_PREFIX = "[reaction-runner]"

const DEFAULT_MAX_REACTION_DEPTH = 4

const DEFAULT_MAX_CONCURRENT = 4

const DEFAULT_RETRY_INTERVAL_MS = 30_000

const DEFAULT_BACKOFF_CAP_MS = 600_000

const DEFAULT_BACKOFF_BASE_MS = 30_000

function defaultBackoffMs(attempt: number): number {
  return Math.min(DEFAULT_BACKOFF_BASE_MS * 2 ** (attempt - 1), DEFAULT_BACKOFF_CAP_MS)
}

// ── Factory ───────────────────────────────────────────────────────────

export function createReactionRunner(opts: ReactionRunnerOptions): ReactionRunner {
  const { bus, store } = opts
  const nowMs = opts.nowMs ?? Date.now
  const maxReactionDepth = opts.maxReactionDepth ?? DEFAULT_MAX_REACTION_DEPTH
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const backoffMs = opts.backoffMs ?? defaultBackoffMs
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const setIntervalFn = opts.setInterval ?? setInterval
  const clearIntervalFn = opts.clearInterval ?? clearInterval
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const trace = opts.trace ?? ((line: string): void => console.info(line))

  const logLine = (message: string): void => {
    log(`${LOG_PREFIX} ${message}`)
  }

  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  const EMPTY_COUNTS = (): { pending: number; running: number; done: number; failed: number; dead: number } => ({
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    dead: 0,
  })

  const incrementCount = (
    counts: { pending: number; running: number; done: number; failed: number; dead: number },
    status: ReactionReceipt["status"],
  ): void => {
    counts[status] += 1
  }

  const percentile = (sorted: readonly number[], p: number): number => {
    if (sorted.length === 0) return 0
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number
  }

  const sanitizeReason = (reason: string): string => reason.slice(0, 120).replace(/\s+/g, "_")

  const emitTrace = (key: string): void => {
    const row = store.get(key)
    if (!row) return
    if (row.status !== "done" && row.status !== "failed" && row.status !== "dead") return
    const parts = [
      `receipt=${row.receiptKey}`,
      `binding=${row.bindingId}`,
      `status=${row.status}`,
      `depth=${row.reactionDepth}`,
      `attempt=${row.attempt}`,
    ]
    if (row.startedAt !== undefined) {
      parts.push(`latencyMs=${nowMs() - row.startedAt}`)
      parts.push(`queueAgeMs=${row.startedAt - row.createdAt}`)
    }
    if (row.status === "failed" && row.nextAttemptAt !== undefined) {
      parts.push(`retryAt=${row.nextAttemptAt}`)
    }
    if ((row.status === "failed" || row.status === "dead") && row.lastError !== undefined) {
      parts.push(`reason=${sanitizeReason(row.lastError)}`)
    }
    try {
      trace(`${LOG_PREFIX} ${parts.join(" ")}`)
    } catch {
      // a throwing trace must never break the run
    }
  }

  let currentBindings: readonly ReactionBinding[] = []
  let bindingById = new Map<string, ReactionBinding>()
  const skipped = new Map<string, number>()

  const applyBindings = (next: readonly ReactionBinding[]): void => {
    const byId = new Map<string, ReactionBinding>()
    for (const binding of next) byId.set(binding.bindingId, binding)
    bindingById = byId
    currentBindings = next.slice()
  }

  applyBindings(opts.bindings)

  // ── Concurrency limiter ─────────────────────────────────────────────

  let active = 0
  const waiters: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      waiters.push(() => {
        active += 1
        resolve()
      })
    })
  }

  const release = (): void => {
    active -= 1
    const next = waiters.shift()
    if (next) next()
  }

  const inFlight = new Set<string>()

  // ── Helpers ─────────────────────────────────────────────────────────

  const sessionIdOf = (event: SessionEvent): string | undefined => {
    const value = (event as { sessionId?: unknown }).sessionId
    return typeof value === "string" ? value : undefined
  }

  const markDeadSafe = async (key: string, reason: string): Promise<void> => {
    try {
      await store.markDead(key, reason)
    } catch (err) {
      logLine(`markDead ${key} failed: ${messageOf(err)}`)
    }
  }

  const targetInput = (receipt: ReactionReceipt): ReactionTargetInput => ({
    receiptKey: receipt.receiptKey,
    sessionId: receipt.sessionId,
    event: receipt.event,
    occurrenceId: receipt.occurrenceId,
    bindingId: receipt.bindingId,
    reactionDepth: receipt.reactionDepth,
    ...(receipt.causedByEventId !== undefined ? { causedByEventId: receipt.causedByEventId } : {}),
  })

  const markFailedSafe = async (
    key: string,
    binding: ReactionBinding,
    receipt: ReactionReceipt,
    error: string,
  ): Promise<void> => {
    const nextAttemptAt = nowMs() + backoffMs(receipt.attempt)
    try {
      await store.markFailed(key, error, nextAttemptAt)
    } catch (err) {
      logLine(`markFailed ${key} (${binding.bindingId}) failed: ${messageOf(err)}`)
    }
  }

  const invokeTarget = async (binding: ReactionBinding, receipt: ReactionReceipt): Promise<void> => {
    const key = receipt.receiptKey
    let outcome: ReactionTargetOutcome
    try {
      outcome = await runInReactionContext(
        {
          bindingId: binding.bindingId,
          reactionDepth: receipt.reactionDepth + 1,
          causedByEventId: receipt.receiptKey,
        },
        () => binding.target.run(targetInput(receipt)),
      )
    } catch (err) {
      await markFailedSafe(key, binding, receipt, messageOf(err))
      emitTrace(key)
      return
    }

    if (outcome.ok) {
      try {
        await store.markDone(key, outcome.outcomeRef)
      } catch (err) {
        logLine(`markDone ${key} (${binding.bindingId}) failed: ${messageOf(err)}`)
        return
      }
      emitTrace(key)
      return
    }

    if (outcome.retryable === false) {
      await markDeadSafe(key, outcome.error ?? "non_retryable")
      emitTrace(key)
      return
    }

    await markFailedSafe(key, binding, receipt, outcome.error ?? "failed")
    emitTrace(key)
  }

  const runReceipt = async (
    binding: ReactionBinding,
    receipt: ReactionReceipt,
    opts?: { redrive?: boolean },
  ): Promise<void> => {
    const key = receipt.receiptKey
    if (inFlight.has(key)) return
    inFlight.add(key)
    await acquire()
    try {
      try {
        await store.markRunning(key, opts)
      } catch (err) {
        if (
          err instanceof ReceiptTransitionError &&
          (err.code === "already_running" || err.code === "terminal")
        ) {
          return
        }
        logLine(`markRunning ${key} (${binding.bindingId}) failed: ${messageOf(err)}`)
        return
      }

      const current = store.get(key)
      if (!current) {
        logLine(`receipt ${key} vanished after markRunning`)
        return
      }
      await invokeTarget(binding, current)
    } finally {
      release()
      inFlight.delete(key)
    }
  }

  const runBinding = async (
    binding: ReactionBinding,
    event: SessionEvent,
    occurrenceId: string,
  ): Promise<void> => {
    try {
      const sessionId = sessionIdOf(event)
      if (sessionId === undefined) {
        logLine(`ignoring ${event.type} for ${binding.bindingId}: event has no sessionId`)
        return
      }

      if (binding.shouldHandle) {
        let applies: boolean
        try {
          applies = await binding.shouldHandle(event)
        } catch (err) {
          logLine(`shouldHandle ${binding.bindingId} failed: ${messageOf(err)}`)
          return
        }
        if (!applies) {
          skipped.set(binding.bindingId, (skipped.get(binding.bindingId) ?? 0) + 1)
          return
        }
      }

      let key: string
      try {
        key = buildReactionReceiptKey({
          sessionId,
          event: event.type,
          occurrenceId,
          bindingId: binding.bindingId,
        })
      } catch (err) {
        logLine(`invalid receipt key for ${binding.bindingId}: ${messageOf(err)}`)
        return
      }

      let cause: { reactionDepth: number; causedByEventId?: string } | undefined
      try {
        cause = binding.causation?.(event)
      } catch (err) {
        logLine(`causation ${binding.bindingId} failed: ${messageOf(err)}`)
        cause = undefined
      }
      const reactionDepth = cause?.reactionDepth ?? binding.reactionDepth

      let inserted: ReactionReceipt
      try {
        inserted = await store.insertPending({
          sessionId,
          event: event.type,
          occurrenceId,
          bindingId: binding.bindingId,
          actionId: binding.actionId,
          configRevision: binding.configRevision,
          maxAttempts: binding.maxAttempts,
          reactionDepth,
          ...(cause?.causedByEventId !== undefined
            ? { causedByEventId: cause.causedByEventId }
            : {}),
        })
      } catch (err) {
        logLine(`insertPending ${key} (${binding.bindingId}) failed: ${messageOf(err)}`)
        return
      }

      const current = store.get(key) ?? inserted
      if (reactionDepth >= maxReactionDepth) {
        if (current.status !== "done" && current.status !== "dead") {
          await markDeadSafe(key, "recursion_cap")
          emitTrace(key)
        }
        return
      }

      if (current.status === "done" || current.status === "dead" || current.status === "running") {
        return
      }
      if (
        current.status === "failed" &&
        current.nextAttemptAt !== undefined &&
        current.nextAttemptAt > nowMs()
      ) {
        return
      }

      await runReceipt(binding, current)
    } catch (err) {
      logLine(`reaction ${binding.bindingId} failed: ${messageOf(err)}`)
    }
  }

  // ── Bus wiring ──────────────────────────────────────────────────────

  let started = false
  let tick: ReturnType<typeof setInterval> | null = null
  const unsubscribers: Array<() => void> = []
  const subscribedEvents = new Set<string>()

  const subscribe = (eventType: string): void => {
    if (subscribedEvents.has(eventType)) return
    subscribedEvents.add(eventType)
    const unsubscribe = bus.on(eventType as SessionEventType, event => {
      onBusEvent(event)
    })
    unsubscribers.push(unsubscribe)
  }

  const onBusEvent = (event: SessionEvent): void => {
    for (const binding of currentBindings) {
      if (binding.event !== event.type) continue
      try {
        const occurrenceId = binding.occurrenceIdOf(event)
        if (occurrenceId === undefined) continue
        void runBinding(binding, event, occurrenceId)
      } catch (err) {
        logLine(`occurrenceIdOf ${binding.bindingId} failed: ${messageOf(err)}`)
      }
    }
  }

  // ── Runner ──────────────────────────────────────────────────────────

  const runner: ReactionRunner = {
    start(): void {
      if (started) return
      started = true
      for (const binding of currentBindings) subscribe(binding.event)
      tick = setIntervalFn(() => {
        runner.retryDue().catch(err => {
          logLine(`retryDue failed: ${messageOf(err)}`)
        })
      }, retryIntervalMs)
      ;(tick as { unref?: () => void }).unref?.()
    },

    stop(): void {
      if (!started) return
      started = false
      subscribedEvents.clear()
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe()
        } catch {
          // never throw in the shutdown path
        }
      }
      if (tick !== null) {
        try {
          clearIntervalFn(tick)
        } catch {
          // never throw in the shutdown path
        }
        tick = null
      }
    },

    async handleEvent(event: SessionEvent, occurrenceId: string): Promise<void> {
      if (sessionIdOf(event) === undefined) {
        logLine(`ignoring ${event.type}: event has no sessionId`)
        return
      }
      const matching = currentBindings.filter(binding => binding.event === event.type)
      await Promise.all(matching.map(binding => runBinding(binding, event, occurrenceId)))
    },

    async retryDue(): Promise<void> {
      try {
        const now = nowMs()
        const due: Array<{ binding: ReactionBinding; receipt: ReactionReceipt }> = []
        for (const receipt of store.rows()) {
          if (receipt.status !== "failed") continue
          const binding = bindingById.get(receipt.bindingId)
          if (!binding) continue
          if (receipt.nextAttemptAt !== undefined && receipt.nextAttemptAt > now) continue
          due.push({ binding, receipt })
        }
        await Promise.all(due.map(({ binding, receipt }) => runReceipt(binding, receipt)))
      } catch (err) {
        logLine(`retryDue failed: ${messageOf(err)}`)
      } finally {
        try {
          store.sweep()
        } catch (err) {
          logLine(`retryDue failed: ${messageOf(err)}`)
        }
      }
    },

    async reconcileOnBoot(): Promise<void> {
      try {
        const snapshot = store.rows()
        const unknownLogged = new Set<string>()
        const stuckLogged = new Set<string>()
        const tasks: Array<Promise<void>> = []

        for (const receipt of snapshot) {
          const binding = bindingById.get(receipt.bindingId)
          if (!binding) {
            if (!unknownLogged.has(receipt.bindingId)) {
              unknownLogged.add(receipt.bindingId)
              logLine(`unknown binding ${receipt.bindingId}: receipts left untouched`)
            }
            continue
          }

          if (receipt.status === "done" || receipt.status === "dead") continue

          if (receipt.status === "pending") {
            tasks.push(
              (async () => {
                if (binding.isTriggerValid) {
                  let valid: boolean
                  try {
                    valid = await binding.isTriggerValid(receipt)
                  } catch (err) {
                    logLine(`isTriggerValid ${receipt.receiptKey} failed: ${messageOf(err)}`)
                    valid = false
                  }
                  if (!valid) {
                    await markDeadSafe(receipt.receiptKey, "stale_trigger")
                    return
                  }
                }
                await runReceipt(binding, receipt)
              })(),
            )
            continue
          }

          if (receipt.status === "running") {
            if (!binding.target.idempotent) {
              if (!stuckLogged.has(receipt.receiptKey)) {
                stuckLogged.add(receipt.receiptKey)
                logLine(
                  `receipt ${receipt.receiptKey} is running for a non idempotent target; not replayed`,
                )
              }
              continue
            }
            tasks.push(runReceipt(binding, receipt, { redrive: true }))
            continue
          }

          if (receipt.status === "failed") {
            if (receipt.attempt >= receipt.maxAttempts) {
              tasks.push(markDeadSafe(receipt.receiptKey, "max_attempts"))
              continue
            }
            if (receipt.nextAttemptAt !== undefined && receipt.nextAttemptAt > nowMs()) continue
            tasks.push(runReceipt(binding, receipt))
          }
        }

        await Promise.all(tasks)
      } catch (err) {
        logLine(`boot reconciliation failed: ${messageOf(err)}`)
      } finally {
        try {
          store.sweep()
        } catch (err) {
          logLine(`sweep failed: ${messageOf(err)}`)
        }
      }
    },

    replaceBindings(next: readonly ReactionBinding[]): void {
      const previous = currentBindings
      applyBindings(next)
      const nextIds = new Set(next.map(binding => binding.bindingId))
      const removed = previous
        .map(binding => binding.bindingId)
        .filter(bindingId => !nextIds.has(bindingId))
      for (const bindingId of removed) skipped.delete(bindingId)
      if (removed.length > 0) logLine(`bindings removed: ${removed.join(", ")}`)
      if (started) {
        for (const binding of currentBindings) subscribe(binding.event)
      }
    },

    health(): ReactionHealth {
      try {
        const now = nowMs()
        const rows = store.rows()
        const liveIds = new Set(currentBindings.map(binding => binding.bindingId))
        const grouped = new Map<string, ReactionReceipt[]>()
        const orphanCounts = new Map<string, ReturnType<typeof EMPTY_COUNTS>>()
        const totals = { receipts: 0, ...EMPTY_COUNTS() }

        for (const row of rows) {
          totals.receipts += 1
          incrementCount(totals, row.status)
          const group = grouped.get(row.bindingId)
          if (group) group.push(row)
          else grouped.set(row.bindingId, [row])
          if (!liveIds.has(row.bindingId)) {
            const counts = orphanCounts.get(row.bindingId) ?? EMPTY_COUNTS()
            incrementCount(counts, row.status)
            orphanCounts.set(row.bindingId, counts)
          }
        }

        const bindings: ReactionBindingHealth[] = currentBindings.map(binding => {
          const receipts = grouped.get(binding.bindingId) ?? []
          const counts = EMPTY_COUNTS()
          const deadReasons: Record<string, number> = {}
          const durations: number[] = []
          let oldestCreatedAt: number | undefined
          let maxDepth = 0
          let retries = 0
          let lastError: string | undefined
          let lastUpdated = Number.NEGATIVE_INFINITY

          for (const receipt of receipts) {
            incrementCount(counts, receipt.status)
            maxDepth = Math.max(maxDepth, receipt.reactionDepth)
            if (receipt.attempt >= 1) retries += receipt.attempt - 1

            if (receipt.status === "pending" || receipt.status === "failed") {
              if (oldestCreatedAt === undefined || receipt.createdAt < oldestCreatedAt) {
                oldestCreatedAt = receipt.createdAt
              }
            }

            if (
              receipt.status === "done" &&
              receipt.startedAt !== undefined &&
              receipt.completedAt !== undefined &&
              receipt.completedAt >= receipt.startedAt
            ) {
              durations.push(receipt.completedAt - receipt.startedAt)
            }

            if (receipt.status === "dead" && receipt.lastError !== undefined) {
              deadReasons[receipt.lastError] = (deadReasons[receipt.lastError] ?? 0) + 1
            }

            if (
              (receipt.status === "failed" || receipt.status === "dead") &&
              receipt.lastError !== undefined
            ) {
              const updatedAt = Math.max(
                receipt.completedAt ?? Number.NEGATIVE_INFINITY,
                receipt.lastAttemptAt ?? Number.NEGATIVE_INFINITY,
              )
              if (updatedAt >= lastUpdated) {
                lastUpdated = updatedAt
                lastError = receipt.lastError
              }
            }
          }

          durations.sort((a, b) => a - b)
          const health: ReactionBindingHealth = {
            bindingId: binding.bindingId,
            event: binding.event,
            counts,
            maxDepth,
            retries,
            deadReasons,
            skipped: skipped.get(binding.bindingId) ?? 0,
          }
          if (oldestCreatedAt !== undefined) health.oldestQueuedAgeMs = now - oldestCreatedAt
          if (durations.length > 0) {
            health.latencyMs = {
              count: durations.length,
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
              max: durations[durations.length - 1] as number,
            }
          }
          if (lastError !== undefined) health.lastError = lastError
          return health
        })

        return {
          generatedAt: now,
          started,
          maxReactionDepth,
          maxConcurrent,
          bindings,
          orphans: Array.from(orphanCounts, ([bindingId, counts]) => ({ bindingId, counts })),
          totals,
        }
      } catch (err) {
        logLine(`health failed: ${messageOf(err)}`)
        return {
          generatedAt: nowMs(),
          started,
          maxReactionDepth,
          maxConcurrent,
          bindings: currentBindings.map(binding => ({
            bindingId: binding.bindingId,
            event: binding.event,
            counts: EMPTY_COUNTS(),
            maxDepth: 0,
            retries: 0,
            deadReasons: {},
            skipped: skipped.get(binding.bindingId) ?? 0,
          })),
          orphans: [],
          totals: { receipts: 0, ...EMPTY_COUNTS() },
        }
      }
    },

    status(): ReactionRunnerStatus[] {
      const stats = new Map<string, ReactionRunnerStatus>()
      for (const binding of currentBindings) {
        stats.set(binding.bindingId, {
          bindingId: binding.bindingId,
          pending: 0,
          running: 0,
          failed: 0,
          dead: 0,
        })
      }
      const lastUpdated = new Map<string, number>()

      for (const receipt of store.rows()) {
        const entry = stats.get(receipt.bindingId)
        if (!entry) continue
        if (receipt.status === "pending") entry.pending += 1
        else if (receipt.status === "running") entry.running += 1
        else if (receipt.status === "failed") entry.failed += 1
        else if (receipt.status === "dead") entry.dead += 1

        if (
          (receipt.status === "failed" || receipt.status === "dead") &&
          receipt.lastError !== undefined
        ) {
          const updatedAt = Math.max(
            receipt.completedAt ?? Number.NEGATIVE_INFINITY,
            receipt.lastAttemptAt ?? Number.NEGATIVE_INFINITY,
          )
          const previous = lastUpdated.get(receipt.bindingId)
          if (previous === undefined || updatedAt >= previous) {
            lastUpdated.set(receipt.bindingId, updatedAt)
            entry.lastError = receipt.lastError
          }
        }
      }

      return currentBindings.map(binding => {
        const entry = stats.get(binding.bindingId)
        if (entry) return entry
        return { bindingId: binding.bindingId, pending: 0, running: 0, failed: 0, dead: 0 }
      })
    },
  }

  return runner
}
