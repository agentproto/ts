/**
 * Sentinel triage: observation-only classification of sentinel events
 * (AIP-60) BEFORE `sentinel-runtime.ts` hands them to `sendMessage`.
 *
 * This is the ledger half of a future pre-wake filter: every delivered event
 * is classified `wake` | `fyi` | `drop` by a fixed, deterministic rule order
 * and the decision is appended to a JSONL journal. DELIVERY DOES NOT CHANGE:
 * the runtime still delivers with the sentinel's configured urgency; the
 * decision here is recorded, never applied (`applied: false`).
 *
 * Rules, in order (first match wins):
 *  1. `terminal`: `event.terminal === true` -> `wake`.
 *  2. `coalesced-repeat`: the event has a coalesce key (see
 *     `sentinel-coalesce.ts`) and the same `(target, key)` was seen in the
 *     last {@link REPEAT_WINDOW_MS} -> `fyi`.
 *  3. `default` -> `wake`.
 *
 * There is deliberately no own-actor rule: `SentinelEvent` has no actor.
 *
 * Pure except {@link writeSentinelTriageLedger}. The recent-key map is
 * bounded ({@link RECENT_KEYS_CAP}) and owned by the runtime (created once),
 * never persisted.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { MessageUrgency } from "./session-message.js"
import type { TriageDecision } from "./follow-triage.js"
import { coalesceKeyFor } from "./sentinel-coalesce.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"

/** How long a `(target, key)` pair counts as "just seen". */
export const REPEAT_WINDOW_MS = 10 * 60 * 1000

/** Maximum number of remembered `(target, key)` pairs. */
export const RECENT_KEYS_CAP = 1000

export interface SentinelTriageResult {
  decision: TriageDecision
  rule: string
}

export interface SentinelTriageContext {
  /** The session the event would be delivered to. */
  target: string
  sentinelId: string
  now: number
  recent: RecentKeys
}

function recentKey(target: string, key: string): string {
  return `${target}\u0000${key}`
}

/**
 * Bounded in-memory `(target, key) -> lastSeenMs` map. Insertion order is
 * recency order: recording an existing pair moves it to the end, and the
 * oldest entry is evicted when the cap is exceeded.
 */
export class RecentKeys {
  private readonly seen = new Map<string, number>()

  constructor(private readonly cap: number = RECENT_KEYS_CAP) {}

  /** Was `(target, key)` recorded strictly inside the last `windowMs`? The
   *  exact boundary is OUTSIDE the window (age === window does not count). */
  has(target: string, key: string, now: number, windowMs: number = REPEAT_WINDOW_MS): boolean {
    const lastSeen = this.seen.get(recentKey(target, key))
    return lastSeen !== undefined && now - lastSeen < windowMs
  }

  record(target: string, key: string, now: number): void {
    const composite = recentKey(target, key)
    this.seen.delete(composite)
    this.seen.set(composite, now)
    while (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  get size(): number {
    return this.seen.size
  }
}

export function createRecentKeys(cap: number = RECENT_KEYS_CAP): RecentKeys {
  return new RecentKeys(cap)
}

/**
 * Classify one event that is about to be delivered. Records the event's
 * coalesce key AFTER classifying so the NEXT occurrence sees it, never this
 * one.
 */
export function classifySentinelEvent(
  event: SentinelEvent,
  ctx: SentinelTriageContext,
): SentinelTriageResult {
  const key = coalesceKeyFor(event)

  let result: SentinelTriageResult
  if (event.terminal === true) {
    result = { decision: "wake", rule: "terminal" }
  } else if (key !== undefined && ctx.recent.has(ctx.target, key, ctx.now)) {
    result = { decision: "fyi", rule: "coalesced-repeat" }
  } else {
    result = { decision: "wake", rule: "default" }
  }

  if (key !== undefined) ctx.recent.record(ctx.target, key, ctx.now)
  return result
}

/** One JSONL line. Identifiers and routing metadata only: NEVER message
 *  text, event `data`, or `summary`. */
export interface SentinelTriageLedgerLine {
  ts: string
  source: "sentinel"
  applied: false
  decision: TriageDecision
  rule: string
  target: string
  sentinelId: string
  eventId: string
  type: string
  subject: string
  urgency: MessageUrgency
}

/**
 * Append one ledger line. The projection is explicit so stray extra fields
 * (`summary`, `data`, `text`, ...) can never reach the journal. Throws on
 * I/O failure; the runtime wraps the call and logs instead.
 */
export function writeSentinelTriageLedger(path: string, line: SentinelTriageLedgerLine): void {
  const record: SentinelTriageLedgerLine = {
    ts: line.ts,
    source: line.source,
    applied: line.applied,
    decision: line.decision,
    rule: line.rule,
    target: line.target,
    sentinelId: line.sentinelId,
    eventId: line.eventId,
    type: line.type,
    subject: line.subject,
    urgency: line.urgency,
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 })
}
