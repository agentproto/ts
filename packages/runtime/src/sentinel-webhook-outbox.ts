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
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, promises as fsp } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"

import {
  deliverEventEnvelope,
  serializeEnvelope,
  type DeliveryOutcome,
  type DeliveryReplay,
  type McpEventEnvelope,
} from "./webhook-egress/delivery.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"

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

export interface SentinelWebhookOutbox {
  /** Append a row for a matched webhook-delivery event. Idempotent per
   *  `(sentinelId, eventId)`: an existing row (pending OR terminal) is never
   *  duplicated — returns `undefined`, and for a terminal existing row
   *  re-fires `onTerminal` so a lost ack (crash between the terminal
   *  transition and the store write) still lands. Kicks dispatch off
   *  asynchronously. */
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
  /** Debounce interval for disk persistence. Default 1500 ms. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default false unless filePath. */
  persist?: boolean
  /** DI boundary (not module fakes): replaces W-A's `deliverEventEnvelope`
   *  as the POST boundary. Throws = dispatch did not complete (row stays
   *  pending, event stays un-acked). Default: the real deliverer. */
  deliverEvent?: (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) => Promise<DeliveryOutcome>
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

let tmpSeq = 0

/** `sub_<hex32>` — deterministic over (sentinelId, eventId). */
export function webhookRequestId(sentinelId: string, eventId: string): `sub_${string}` {
  const digest = createHash("sha256").update(`${sentinelId}:${eventId}`).digest("hex")
  return `sub_${digest.slice(0, 32)}`
}

/** The CloudEvents → MCP-Events-envelope fusion this WP owns (W-C's adapter
 *  becomes the canonical owner of the same mapping; this shape is the frozen
 *  §3 wire envelope — insertion order stable, so its serialization is
 *  byte-stable across restarts). `data` gains `subject`/`summary` so the
 *  256 KiB clamp's `{summary, subject}` replacement never goes blind. */
export function toWebhookEnvelope(event: SentinelEvent): McpEventEnvelope {
  return {
    eventId: event.id,
    name: event.type,
    timestamp: event.time,
    data: { ...event.data, subject: event.subject, summary: event.summary },
    cursor: null,
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createSentinelWebhookOutbox(opts: SentinelWebhookOutboxOptions): SentinelWebhookOutbox {
  const filePath = opts.filePath ?? resolve(agentprotoHome(), "sentinel-webhook-outbox.json")
  const nowMs = opts.nowMs ?? Date.now
  const debounceMs = opts.debounceMs ?? PERSIST_DEBOUNCE_MS
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const persist = opts.persist ?? opts.filePath !== undefined
  const deliverEvent =
    opts.deliverEvent ??
    (async (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) =>
      deliverEventEnvelope(input.replay, input.row.envelope as McpEventEnvelope))

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

  // ── Persistence (atomic tmp+rename, 0600, same idiom as the store) ───

  const snapshot = (): Record<string, PersistedOutboxRow> => {
    const out: Record<string, PersistedOutboxRow> = {}
    for (const [key, row] of rows.entries()) out[key] = row
    return out
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          await fsp.mkdir(dirname(filePath), { recursive: true })
          const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
          await fsp.writeFile(tmp, JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await fsp.rename(tmp, filePath)
        } catch (err) {
          log(`[sentinel-webhook-outbox] persist failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
      writeFileSync(tmp, JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, filePath)
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
    } catch (err) {
      // Crash-shaped: the dispatch did NOT complete — the row stays
      // pending, the event stays UN-acked (no markSeen), and
      // `resumeDeliveries()` re-runs it by exact bytes next startup.
      row.deliveryState = {
        ...(row.deliveryState ?? { attempts: 0 }),
        lastError: err instanceof Error ? err.message : String(err),
        lastAt: new Date(nowMs()).toISOString(),
      }
      row.status = "pending"
      log(`[sentinel-webhook-outbox] dispatch failed, row left pending: ${row.sentinelId} ${row.eventId}`)
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
        if (existing.status !== "pending") opts.onTerminal(sentinelId, existing)
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
      if (rows.size >= ROW_CAP) {
        const oldest = oldestTerminalRowKey()
        if (oldest) rows.delete(oldest)
      }

      rows.set(key, row)
      schedulePersist()
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

    flushSync,
  }
}
