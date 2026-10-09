/**
 * SentinelWebhookOutbox — the PERSISTED outbox for `webhook`-target sentinel
 * events (W-B of `.plans/sentinel-mcp-events/PLAN.md`, §4 task 3).
 *
 * Why an outbox: the runtime's `processEvents` marks an event `seen` the
 * moment in-process handling resolves, but a webhook POST is an EXTERNAL
 * delivery — a crash between ack and delivery loses the event forever (I4).
 * So the webhook fire path appends a DURABLE row first:
 *
 *   `{sentinelId, requestId, eventId, bodyBytes, cursor:null,
 *     deliveryState, status: pending|delivered|dead}`
 *
 * with `bodyBytes` = the EXACT canonical body bytes that will be sent (I2 —
 * the envelope is serialized once here via `serializeEnvelope`; the dispatch
 * re-signs those same bytes, and `deliverEventEnvelope`'s internal
 * serialization is deterministic over the stored envelope — asserted by
 * tests). The underlying sentinel event is marked seen/acked ONLY when the
 * row reaches terminal status (`delivered`, or `dead` per the retry cap /
 * age-out); a dispatch that THREW (crash-shaped) leaves the row `pending`,
 * the event UN-acked, and a restart re-dispatches it by exact bytes.
 *
 * Ordering across events of one subscription is never assumed (I5). Rows
 * reaped once `delivered` for 24 h; pending rows age out after 7 d (plan
 * risk table); the file is capped. Feedback-loop guard is data, not policy:
 * the `ssrfFetch` gate inside `deliverEventEnvelope` inherently blocks
 * loopback/private delivery targets, so nothing here can ring back into our
 * own inbound routes — self-delivery cannot even connect.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { homedir } from "node:os"

import { writeFileDurable, writeFileDurableSync } from "./durable-file.js"

import {
  callbackHost,
  deliverEventEnvelope,
  redactUrls,
  serializeEnvelope,
  type DeliverEventDeps,
  type DeliveryOutcome,
  type DeliveryReplay,
  type McpEventEnvelope,
} from "./webhook-egress/delivery.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"
import { toMcpEvent } from "./mcp-events/adapter.js"

// ── Types ─────────────────────────────────────────────────────────────

export type SentinelWebhookOutboxStatus = "pending" | "delivered" | "dead"

export interface SentinelWebhookOutboxRow {
  sentinelId: string
  /** Deterministic sub id over `(sentinelId, eventId)` — stable across
   *  restarts (I1: a redelivery is a consumer no-op; the wire `webhook-id`
   *  header stays the EVENT id). */
  requestId: string
  eventId: string
  /** The EXACT body bytes, as sent — utf-8 base64 of `serializeEnvelope`
   *  (I2: bytes stored exactly as sent; resume dispatches the stored bytes). */
  bodyBytes: string
  /** v1 events are non-replayable (plan §2) — always null. */
  cursor: null
  /** Persisted W-A delivery state so a post-restart dispatch makes sense. */
  deliveryState: { attempts: number; lastError?: string; lastAt?: string }
  status: SentinelWebhookOutboxStatus
  /** The bounded-retry loop's final `ok:false` reason. */
  failReason?: string
  /** Why the outbox itself went a row `dead` (`sentinel_expired`,
   *  `sentinel_removed`, `age_out`). */
  deadReason?: string
  createdAt: number
  /** Wall-clock ms the row reached terminal status (drives reaping). */
  terminalAt?: number
}

/** The full row is JSON-persisted; the envelope rides along so a resumed
 *  dispatch re-delivers byte-identically without re-deriving the projection,
 *  and the original event rides along for ack-time lifetime bookkeeping
 *  (terminal flag / subject tracking). */
export type PersistedOutboxRow = SentinelWebhookOutboxRow & {
  envelope?: McpEventEnvelope
  event?: SentinelEvent
}

/** Per-sentinel delivery health, derived from the outbox rows. Carries no
 *  URL, body or secret — `lastError` is URL-redacted. */
export interface SentinelDeliveryStatus {
  /** At least one row is still `pending` (being delivered / retried). */
  active: boolean
  /** ISO time of the most recent delivery attempt, when any ran. */
  lastDeliveryAt?: string
  /** Status of the most recent row. */
  lastStatus: SentinelWebhookOutboxStatus
  lastError?: string
  /** Attempts spent on the most recent row. */
  attempts: number
  /** Count of `dead` rows still held by the outbox. */
  dead: number
}

export interface SentinelWebhookOutbox {
  /** Delivery health for one sentinel, or `undefined` when the outbox holds no
   *  row for it (never delivered anything / reaped). */
  deliveryStatus(sentinelId: string): SentinelDeliveryStatus | undefined
  /** Append a row for a matched webhook-delivery event. Resolves ONLY after
   *  the row is crash-durable (atomic write + fsync + rename + dir fsync) —
   *  callers ack the upstream (Agentpush cursor, push HTTP 2xx) on resolve.
   *  A persistence failure rejects and rolls the row back, so the caller
   *  leaves the upstream un-acked. Idempotent per `(sentinelId, eventId)`: an
   *  existing row (pending OR terminal) is never duplicated — returns
   *  `undefined` (after waiting for any in-flight write that carries it), and
   *  for a terminal existing row re-fires `onTerminal` so a lost ack (crash
   *  between the terminal transition and the store write) still lands. Kicks
   *  dispatch off asynchronously once durable. */
  enqueue(input: { sentinelId: string; event: SentinelEvent }): Promise<SentinelWebhookOutboxRow | undefined>
  /** Dispatch every `pending` row (serialized, one POST in flight). Consults
   *  `isExpired` per row AND the secrets sidecar BEFORE dispatch — an
   *  expired or unwound sentinel never delivers another byte. */
  dispatch(): Promise<void>
  /** Startup re-enqueue: re-dispatch every `pending` row by exact stored
   *  bytes (no payload re-serialization on the resume path). */
  resumeDeliveries(): Promise<void>
  /** Re-`delivered` rows after 24 h are reaped; pending rows age out after
   *  7 d (plan risk table). Cheap; called on the runtime's periodic tick. */
  sweep(): void
  rows(): PersistedOutboxRow[]
  /** Synchronous flush for shutdown paths. */
  flushSync(): void
}

export interface SentinelWebhookOutboxOptions {
  /** Override persist path. Default `~/.agentproto/sentinel-webhook-outbox.json`. */
  filePath?: string
  /** Injectable clock. */
  nowMs?: () => number
  /** Debounce interval for the non-critical (status-transition) disk writes.
   *  Enqueue never debounces. Default 1500 ms. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default false unless filePath. */
  persist?: boolean
  /** DI boundary (not module fakes): replaces W-A's `deliverEventEnvelope`
   *  as the POST boundary. Throws = dispatch did not complete (row stays
   *  pending, event stays un-acked). Default: the real deliverer. */
  deliverEvent?: (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) => Promise<DeliveryOutcome>
  /** Test seam for the DEFAULT deliverer only (fetch / sleep / clock). */
  deliverDeps?: Pick<DeliverEventDeps, "fetch" | "sleep" | "now">
  /** Signing secrets for a sentinel — `{subId, callbackUrl, secrets[]}`, or
   *  null when the sentinel/secret sidecar is gone (row goes dead, never
   *  silently lost). */
  secretsFor: (sentinelId: string) => DeliveryReplay | null
  /** Expiry gate, consulted BEFORE every dispatch (plan §4 W-B task 2b).
   *  true = the sentinel is past its `until` and must not deliver. */
  isExpired: (sentinelId: string) => boolean
  /** The ack — mark the underlying event seen, after terminal status only. */
  onTerminal: (sentinelId: string, row: SentinelWebhookOutboxRow) => void
  log?: (line: string) => void
}

// ── Constants ─────────────────────────────────────────────────────────

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

const PERSIST_DEBOUNCE_MS = 1_500

/** `delivered` rows are reaped after 24 h (plan §4 W-B task 3). */
const DELIVERED_REAP_MS = 24 * 60 * 60 * 1000

/** Pending rows older than 7 d age out (plan risk table: "events older
 *  than 7d silently dropped, logged once"). */
const PENDING_AGE_OUT_MS = 7 * 24 * 60 * 60 * 1000

/** Bounded row file — the oldest terminal row is evicted beyond this. */
const ROW_CAP = 2_000

/** `sub_<hex32>` — deterministic over (sentinelId, eventId). */
export function webhookRequestId(sentinelId: string, eventId: string): `sub_${string}` {
  const digest = createHash("sha256").update(`${sentinelId}:${eventId}`).digest("hex")
  return `sub_${digest.slice(0, 32)}`
}

/** The CloudEvents → MCP-Events-envelope fusion. W-C's `mcp-events/adapter.ts`
 *  is now the canonical owner of this mapping (`toMcpEvent`); this alias keeps
 *  the W-B call sites/tests working. The shape is the frozen §3 wire envelope —
 *  insertion order stable, so its serialization is byte-stable across
 *  restarts. `data` gains `subject`/`summary` so the 256 KiB clamp's
 *  `{summary, subject}` replacement never goes blind. */
export function toWebhookEnvelope(event: SentinelEvent): McpEventEnvelope {
  return toMcpEvent(event)
}

// ── Factory ───────────────────────────────────────────────────────────

export function createSentinelWebhookOutbox(opts: SentinelWebhookOutboxOptions): SentinelWebhookOutbox {
  const filePath = opts.filePath ?? resolve(agentprotoHome(), "sentinel-webhook-outbox.json")
  const nowMs = opts.nowMs ?? Date.now
  const debounceMs = opts.debounceMs ?? PERSIST_DEBOUNCE_MS
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const persist = opts.persist ?? opts.filePath !== undefined
  // One concise line per attempt. Host only: the URL path can carry a bearer
  // token, and neither body nor secret is ever passed in here.
  const deliveryLog = (row: PersistedOutboxRow, host: string, detail: string): void => {
    log(`[sentinel-webhook-outbox] sentinel=${row.sentinelId} event=${row.eventId} host=${host} ${detail}`)
  }
  const deliverEvent =
    opts.deliverEvent ??
    (async (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) => {
      const host = callbackHost(input.replay.callbackUrl)
      return deliverEventEnvelope(input.replay, input.row.envelope as McpEventEnvelope, {
        ...opts.deliverDeps,
        onAttempt: a =>
          deliveryLog(
            input.row,
            host,
            `attempt=${a.attempt} ${a.status !== undefined ? `http=${a.status}` : `error="${a.error ?? "unknown"}"`} ${a.outcome}`,
          ),
      })
    })

  const rowKey = (sentinelId: string, eventId: string): string => `${sentinelId}::${eventId}`

  // ── Load-on-construct ────────────────────────────────────────────────

  const load = (): Map<string, PersistedOutboxRow> => {
    const out = new Map<string, PersistedOutboxRow>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`[sentinel-webhook-outbox] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`)
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, PersistedOutboxRow>
      for (const row of Object.values(parsed)) {
        if (typeof row?.sentinelId === "string" && typeof row?.eventId === "string") {
          out.set(rowKey(row.sentinelId, row.eventId), row)
        }
      }
    } catch (err) {
      log(`[sentinel-webhook-outbox] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`)
    }
    return out
  }

  const rows = load()

  // ── Persistence (atomic tmp+fsync+rename+dir fsync, 0600) ────────────
  //
  // All writes ride ONE serialized chain so a slow older snapshot can never
  // land after a newer one; each write snapshots the rows when it STARTS.
  // `enqueue` awaits its write (durable-before-ack); status transitions use
  // the debounced, best-effort variant — losing one only re-delivers a row
  // (at-least-once), never loses it.

  const snapshot = (): Record<string, PersistedOutboxRow> => {
    const out: Record<string, PersistedOutboxRow> = {}
    for (const [key, row] of rows.entries()) out[key] = row
    return out
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let writeTail: Promise<void> = Promise.resolve()
  /** Bumped by `flushSync` so an in-flight async write that started earlier
   *  cannot rename an older snapshot over the newer synchronous one. */
  let syncGeneration = 0

  const persistNow = (): Promise<void> => {
    if (!persist) return Promise.resolve()
    const run = async (): Promise<void> => {
      const generation = syncGeneration
      const body = JSON.stringify(snapshot(), null, 2) + "\n"
      await writeFileDurable(filePath, body, { commitIf: () => generation === syncGeneration })
    }
    const next = writeTail.then(run, run)
    writeTail = next.catch(() => undefined)
    return next
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow().catch(err => {
        log(`[sentinel-webhook-outbox] persist failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    syncGeneration++
    try {
      writeFileDurableSync(filePath, JSON.stringify(snapshot(), null, 2) + "\n")
    } catch {
      // best-effort — never throw in the shutdown path
    }
  }

  // ── Dispatch worker (serialized; one POST in flight) ────────────────

  const oldestTerminalRowKey = (): string | undefined => {
    const terminal = [...rows.values()]
      .filter(row => row.status === "delivered" || row.status === "dead")
      .sort((a, b) => (a.terminalAt ?? a.createdAt) - (b.terminalAt ?? b.createdAt))
      .at(0)
    return terminal ? rowKey(terminal.sentinelId, terminal.eventId) : undefined
  }

  const reapDelivered = (): void => {
    const now = nowMs()
    for (const row of rows.values()) {
      if (row.status !== "delivered") continue
      if (!row.terminalAt || now - row.terminalAt < DELIVERED_REAP_MS) continue
      rows.delete(rowKey(row.sentinelId, row.eventId))
    }
  }

  const dispatchRow = async (row: PersistedOutboxRow): Promise<void> => {
    // Expiry gate BEFORE a delivery-capable phase (plan §4 W-B task 2b).
    if (opts.isExpired(row.sentinelId)) {
      row.status = "dead"
      row.deadReason = "sentinel_expired"
      row.terminalAt = nowMs()
      opts.onTerminal(row.sentinelId, row)
      schedulePersist()
      return
    }
    const replay = opts.secretsFor(row.sentinelId)
    if (!replay) {
      // Sentinel (or its secret sidecar row) is gone — unwatched mid-flight.
      // Terminal: nothing could ever sign + deliver this row again.
      row.status = "dead"
      row.deadReason = "sentinel_removed"
      row.terminalAt = nowMs()
      opts.onTerminal(row.sentinelId, row)
      schedulePersist()
      return
    }
    try {
      const outcome = await deliverEvent({ replay, row })
      row.deliveryState = outcome.delivery
      if (outcome.ok) {
        row.status = "delivered"
        delete row.failReason
        delete row.deadReason
      } else {
        // The bounded retry loop (W-A owns the cap) came back negative —
        // terminal per plan §4 W-B task 3 ("dead per the retry cap").
        row.status = "dead"
        row.deadReason = "delivered_rejected"
        row.failReason = outcome.reason
      }
      row.terminalAt = nowMs()
      deliveryLog(
        row,
        callbackHost(replay.callbackUrl),
        `final=${row.status} attempts=${outcome.delivery.attempts}` +
          (outcome.ok ? "" : ` reason=${outcome.reason}`),
      )
    } catch (err) {
      // Crash-shaped: the dispatch did NOT complete — the row stays
      // pending, the event stays UN-acked (no markSeen), and
      // `resumeDeliveries()` re-runs it by exact bytes next startup.
      row.deliveryState = {
        ...(row.deliveryState ?? { attempts: 0 }),
        lastError: redactUrls(err instanceof Error ? err.message : String(err)),
        lastAt: new Date(nowMs()).toISOString(),
      }
      row.status = "pending"
      deliveryLog(row, callbackHost(replay.callbackUrl), "dispatch failed, row left pending")
    }
    schedulePersist()
    if (row.status === "delivered" || row.status === "dead") {
      opts.onTerminal(row.sentinelId, row)
    }
  }

  let workTail: Promise<void> = Promise.resolve()

  const enqueueDispatch = (): void => {
    const run = async (): Promise<void> => {
      const pending = [...rows.values()].filter(row => row.status === "pending")
      for (const row of pending) await dispatchRow(row)
      reapDelivered()
      schedulePersist()
    }
    workTail = workTail.then(run, run).catch(() => undefined)
  }

  // ── Public surface ──────────────────────────────────────────────────

  return {
    async enqueue(input: { sentinelId: string; event: SentinelEvent }) {
      const { sentinelId, event } = input
      const key = rowKey(sentinelId, event.id)
      const existing = rows.get(key)
      if (existing) {
        // Dedup (I1): a second row is never created. A terminal existing row
        // means the original dispatch completed while the store-side ack was
        // lost — re-fire it (idempotent).
        if (existing.status !== "pending") {
          opts.onTerminal(sentinelId, existing)
          return undefined
        }
        // A pending duplicate may be the in-flight enqueue of the same event
        // whose write has not landed: the caller must not ack before it does.
        await writeTail
        if (rows.get(key) !== existing) {
          throw new Error(`webhook outbox row ${key} was not persisted`)
        }
        return undefined
      }

      const envelope = toWebhookEnvelope(event)
      const row: PersistedOutboxRow = {
        sentinelId,
        requestId: webhookRequestId(sentinelId, event.id),
        eventId: event.id,
        bodyBytes: Buffer.from(serializeEnvelope(envelope)).toString("base64"),
        cursor: null,
        deliveryState: { attempts: 0 },
        status: "pending",
        createdAt: nowMs(),
        envelope,
        event,
      }

      // Bounded file: evict beyond the cap.
      let evicted: [string, PersistedOutboxRow] | undefined
      if (rows.size >= ROW_CAP) {
        const oldest = oldestTerminalRowKey()
        const evictedRow = oldest ? rows.get(oldest) : undefined
        if (oldest && evictedRow) {
          evicted = [oldest, evictedRow]
          rows.delete(oldest)
        }
      }

      rows.set(key, row)
      try {
        await persistNow()
      } catch (err) {
        // Not durable ⇒ not accepted: roll back so nothing dispatches a row
        // the disk does not hold, and let the caller leave the upstream
        // un-acked.
        if (rows.get(key) === row) rows.delete(key)
        if (evicted && !rows.has(evicted[0])) rows.set(evicted[0], evicted[1])
        throw err
      }
      enqueueDispatch()
      return row
    },

    async dispatch(): Promise<void> {
      enqueueDispatch()
      await workTail
    },

    async resumeDeliveries(): Promise<void> {
      await this.dispatch()
    },

    sweep(): void {
      const now = nowMs()
      for (const row of rows.values()) {
        if (row.status === "delivered" || row.status === "dead") continue
        // Age-out runs strictly AFTER the expiry/presence gates did their
        // part; sweep is periodic and dispatch checks live state.
        if (row.status === "pending" && now - row.createdAt >= PENDING_AGE_OUT_MS) {
          row.status = "dead"
          row.deadReason = "age_out"
          row.terminalAt = now
          opts.onTerminal(row.sentinelId, row)
          schedulePersist()
        }
      }
      reapDelivered()
      while (rows.size > ROW_CAP) {
        const oldest = oldestTerminalRowKey()
        if (!oldest) break
        rows.delete(oldest)
      }
    },

    rows(): PersistedOutboxRow[] {
      return Array.from(rows.values())
    },

    deliveryStatus(sentinelId: string): SentinelDeliveryStatus | undefined {
      let latest: PersistedOutboxRow | undefined
      let active = false
      let dead = 0
      for (const row of rows.values()) {
        if (row.sentinelId !== sentinelId) continue
        if (row.status === "pending") active = true
        if (row.status === "dead") dead++
        if (!latest || (row.terminalAt ?? row.createdAt) >= (latest.terminalAt ?? latest.createdAt)) latest = row
      }
      if (!latest) return undefined
      const lastError = latest.deliveryState.lastError ?? latest.failReason ?? latest.deadReason
      return {
        active,
        ...(latest.deliveryState.lastAt ? { lastDeliveryAt: latest.deliveryState.lastAt } : {}),
        lastStatus: latest.status,
        ...(lastError && latest.status !== "delivered" ? { lastError: redactUrls(lastError) } : {}),
        attempts: latest.deliveryState.attempts,
        dead,
      }
    },

    flushSync,
  }
}
