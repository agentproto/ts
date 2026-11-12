/**
 * The REACH router: one way to reach the owner for each approval, with
 * receipts and a floor.
 *
 * On `approval:requested` it builds one message (`message.ts`) and hands it to
 * the adapters of the owner's route, in order, until one acknowledges
 * (`delivered`, `deferred` or `deduped`). A `deferred` whose `until` is later
 * than the message's `expiresAt` counts as `undelivered(deferred-past-expiry)`
 * and the route goes on. Every attempt is appended to `<id>/reach.json`.
 * When no adapter acknowledges, it emits `reach:undelivered` on the session
 * bus and logs `reach: undelivered <approvalId>`.
 *
 * Before sending it reads `reach.json`: an acknowledging receipt for the same
 * `dedupeKey` means it was already handed over, so nothing is sent again (a
 * daemon restart does not re-announce).
 *
 * The watchdog (every 30 s): a pending approval older than 60 s with no
 * acknowledging receipt is logged `reach: MISSING <approvalId>` and sent
 * through the floor, the last `telegram` adapter of the route, else
 * `reach:undelivered` is emitted. Once per approval per daemon run.
 *
 * On `approval:decided` and `approval:expired` it calls `close` on the
 * adapter that acknowledged, if that adapter has one.
 *
 * An approval requested with `reach: false` is left alone entirely.
 */

import { isAcknowledged, type ReachAdapter, type ReachMessage, type ReachReceipt } from "@agentproto/reach"

import type { ApprovalsEngine } from "../approvals/engine.js"
import type { ReachReceiptEntry } from "../approvals/types.js"
import type { SessionEventBus } from "../session-event-bus.js"
import { approvalDedupeKey, buildApprovalReachMessage } from "./message.js"

export const REACH_WATCHDOG_INTERVAL_MS = 30_000
export const REACH_MISSING_AFTER_MS = 60_000

export interface ReachRouterOptions {
  events: Pick<SessionEventBus, "onAny" | "emit">
  engine: Pick<ApprovalsEngine, "get" | "list" | "listReachReceipts" | "appendReachReceipt">
  /** The owner's route, in order. */
  route: readonly ReachAdapter[]
  /** One line per event worth an operator's eye. Default `console.warn`. */
  log?: (line: string) => void
  watchdogIntervalMs?: number
  missingAfterMs?: number
}

export interface ReachRouter {
  start(): void
  stop(): void
  /** The `approval:requested` pass for one approval. Resolves when done. */
  route(approvalId: string): Promise<void>
  /** One watchdog pass. Resolves when every floor attempt it started is done. */
  sweep(): Promise<void>
}

type Attempt = { adapterId: string; status: string; reason?: string }

export function createReachRouter(opts: ReachRouterOptions): ReachRouter {
  const log = opts.log ?? (line => console.warn(line))
  const intervalMs = opts.watchdogIntervalMs ?? REACH_WATCHDOG_INTERVAL_MS
  const missingAfterMs = opts.missingAfterMs ?? REACH_MISSING_AFTER_MS
  const floor = [...opts.route].reverse().find(a => a.kind === "telegram")

  const inflight = new Map<string, Promise<void>>()
  const missingReported = new Set<string>()
  const closed = new Set<string>()
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function acknowledged(approvalId: string, dedupeKey: string): ReachReceiptEntry | undefined {
    let receipts: ReachReceiptEntry[] = []
    try {
      receipts = opts.engine.listReachReceipts(approvalId)
    } catch (err) {
      log(`reach: could not read receipts for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return [...receipts].reverse().find(r => r.dedupeKey === dedupeKey && isAcknowledged(r))
  }

  async function attempt(
    approvalId: string,
    adapter: ReachAdapter,
    message: ReachMessage,
    trigger: ReachReceiptEntry["trigger"],
  ): Promise<ReachReceipt> {
    let receipt: ReachReceipt
    try {
      receipt = await adapter.send(message)
    } catch {
      receipt = { status: "failed", reason: "adapter-threw", adapterId: adapter.id, at: new Date().toISOString() }
    }
    if (
      receipt.status === "deferred" &&
      message.expiresAt !== undefined &&
      Date.parse(receipt.until) > Date.parse(message.expiresAt)
    ) {
      receipt = { status: "undelivered", reason: "deferred-past-expiry", adapterId: receipt.adapterId, at: receipt.at }
    }
    const entry: ReachReceiptEntry = {
      dedupeKey: message.dedupeKey,
      adapterId: adapter.id,
      kind: adapter.kind,
      status: receipt.status,
      ...(receipt.status === "deferred" ? { until: receipt.until } : {}),
      ...(receipt.status === "undelivered" || receipt.status === "failed" ? { reason: receipt.reason } : {}),
      at: receipt.at,
      trigger,
    }
    try {
      opts.engine.appendReachReceipt(approvalId, entry)
    } catch (err) {
      log(`reach: could not write a receipt for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return receipt
  }

  function undelivered(
    approvalId: string,
    dedupeKey: string,
    trigger: ReachReceiptEntry["trigger"],
    attempts: Attempt[],
  ): void {
    log(`reach: undelivered ${approvalId}`)
    opts.events.emit({ type: "reach:undelivered", approvalId, dedupeKey, trigger, attempts, ts: new Date().toISOString() })
  }

  function summarize(r: ReachReceipt): Attempt {
    return {
      adapterId: r.adapterId,
      status: r.status,
      ...(r.status === "undelivered" || r.status === "failed" ? { reason: r.reason } : {}),
    }
  }

  /** One pass at a time per approval: the route and the watchdog never send
   *  the same approval concurrently. */
  function exclusive(approvalId: string, run: () => Promise<void>): Promise<void> {
    const running = inflight.get(approvalId)
    if (running) return running
    const p = run().finally(() => inflight.delete(approvalId))
    inflight.set(approvalId, p)
    return p
  }

  function routeApproval(approvalId: string): Promise<void> {
    return exclusive(approvalId, async () => {
      const record = opts.engine.get(approvalId)
      if (!record || record.status !== "pending" || record.reach === false) return
      const message = buildApprovalReachMessage(record)
      if (acknowledged(approvalId, message.dedupeKey)) return
      const attempts: Attempt[] = []
      for (const adapter of opts.route) {
        const receipt = await attempt(approvalId, adapter, message, "route")
        attempts.push(summarize(receipt))
        if (isAcknowledged(receipt)) return
      }
      undelivered(approvalId, message.dedupeKey, "route", attempts)
    })
  }

  async function sweep(): Promise<void> {
    const started: Promise<void>[] = []
    const nowMs = Date.now()
    for (const record of opts.engine.list({ status: "pending" })) {
      if (record.reach === false || missingReported.has(record.id) || inflight.has(record.id)) continue
      if (nowMs - Date.parse(record.requestedAt) <= missingAfterMs) continue
      if (acknowledged(record.id, approvalDedupeKey(record.id))) continue
      missingReported.add(record.id)
      log(`reach: MISSING ${record.id}`)
      started.push(
        exclusive(record.id, async () => {
          const current = opts.engine.get(record.id)
          if (!current || current.status !== "pending") return
          const message = buildApprovalReachMessage(current)
          const attempts: Attempt[] = []
          if (floor) {
            const receipt = await attempt(record.id, floor, message, "watchdog")
            attempts.push(summarize(receipt))
            if (isAcknowledged(receipt)) return
          }
          undelivered(record.id, message.dedupeKey, "watchdog", attempts)
        }),
      )
    }
    await Promise.all(started)
  }

  async function close(approvalId: string, outcome: "approved" | "denied" | "expired"): Promise<void> {
    if (closed.has(approvalId)) return
    closed.add(approvalId)
    const dedupeKey = approvalDedupeKey(approvalId)
    const ack = acknowledged(approvalId, dedupeKey)
    const adapter = ack ? opts.route.find(a => a.id === ack.adapterId) : undefined
    if (!adapter?.close) return
    try {
      await adapter.close(dedupeKey, outcome)
    } catch (err) {
      log(`reach: close failed for ${approvalId} on ${adapter.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const report = (err: unknown): void => log(`reach: ${err instanceof Error ? err.message : String(err)}`)

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = opts.events.onAny(ev => {
        if (ev.type === "approval:requested") routeApproval(ev.approvalId).catch(report)
        else if (ev.type === "approval:decided") close(ev.approvalId, ev.decision).catch(report)
        else if (ev.type === "approval:expired") close(ev.approvalId, "expired").catch(report)
      })
      timer = setInterval(() => {
        sweep().catch(report)
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      unsubscribe?.()
      unsubscribe = undefined
      if (timer) clearInterval(timer)
      timer = undefined
    },
    route: routeApproval,
    sweep,
  }
}
