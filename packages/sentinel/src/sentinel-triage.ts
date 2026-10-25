/**
 * Observation-only triage for sentinel deliveries.
 *
 * This module never changes what a sentinel delivers. It answers the
 * question a future triage stage would ask before waking the target, and the
 * runtime records that answer in a JSONL ledger (`applied: false`) beside the
 * delivery it actually performs. The ledger is training data for that later
 * stage, not a gate.
 *
 * Rules are checked in order; the first match wins:
 * 1. `terminal`: an event that ends its subject's lifecycle always wakes.
 * 2. `coalesced-repeat`: the same `(target, coalesce key)` was classified
 *    within the last 10 minutes, so this one is only `fyi`.
 * 3. `default`: everything else wakes.
 *
 * Keys are recorded by the caller AFTER a successful delivery, so an event
 * never counts as a repeat of itself and a failed send is not recorded as
 * seen. {@link RecentKeys} is a bounded map (1000 entries by default) that
 * evicts the oldest insertion when full.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { TriageDecision } from "./follow-triage.js"
import { coalesceKeyFor } from "./sentinel-coalesce.js"
import type { MessageUrgency } from "./session-message.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"

/** How recently the same `(target, key)` must have been seen to count as a
 *  coalesced repeat. */
export const SENTINEL_TRIAGE_REPEAT_WINDOW_MS = 10 * 60 * 1000

/** Default bound on the recent-key map. */
export const DEFAULT_RECENT_KEYS_CAP = 1000

export type SentinelTriageRule = "terminal" | "coalesced-repeat" | "default"

export interface SentinelTriageInput {
  /** Delivery target identity (the target session id). */
  target: string
  sentinelId: string
  now: number
  recent: RecentKeys
}

export interface SentinelTriageResult {
  decision: TriageDecision
  rule: SentinelTriageRule
}

function mapKey(target: string, key: string): string {
  return `${target}\u0000${key}`
}

/** Bounded insertion-ordered map of recently classified coalesce keys.
 *  Re-recording an existing key refreshes it and moves it to the newest
 *  position; recording past the cap evicts the oldest key. */
export class RecentKeys {
  private readonly entries = new Map<string, number>()

  constructor(private readonly cap: number = DEFAULT_RECENT_KEYS_CAP) {}

  get size(): number {
    return this.entries.size
  }

  /** True when this `(target, key)` was recorded less than the repeat
   *  window ago. A key recorded exactly at the window boundary is no longer
   *  a repeat. */
  has(target: string, key: string, now: number): boolean {
    const at = this.entries.get(mapKey(target, key))
    if (at === undefined) return false
    const delta = now - at
    if (delta < 0) return false
    return delta < SENTINEL_TRIAGE_REPEAT_WINDOW_MS
  }

  record(target: string, key: string, now: number): void {
    const id = mapKey(target, key)
    this.entries.delete(id)
    this.entries.set(id, now)
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** Classify one event without applying anything. The caller records the
 *  coalesce key after a successful delivery so a failed send is not counted
 *  as seen and an event never counts as a repeat of itself. */
export function classifySentinelEvent(
  event: SentinelEvent,
  input: SentinelTriageInput,
): SentinelTriageResult {
  const key = coalesceKeyFor(event)

  if (event.terminal === true) {
    return { decision: "wake", rule: "terminal" }
  } else if (key !== undefined && input.recent.has(input.target, key, input.now)) {
    return { decision: "fyi", rule: "coalesced-repeat" }
  } else {
    return { decision: "wake", rule: "default" }
  }
}

/** Record the coalesce key for a successfully delivered event. */
export function recordSentinelTriageKey(
  event: SentinelEvent,
  input: Pick<SentinelTriageInput, "target" | "now" | "recent">,
): void {
  const key = coalesceKeyFor(event)
  if (key !== undefined) {
    input.recent.record(input.target, key, input.now)
  }
}

/** The fields the caller supplies for one ledger line. `source` and
 *  `applied` are owned by {@link writeSentinelTriageLedger}. */
export interface SentinelTriageLedgerRecord {
  ts: string
  decision: TriageDecision
  rule: SentinelTriageRule
  target: string
  sentinelId: string
  eventId: string
  type: string
  subject: string
  urgency: MessageUrgency
}

export interface SentinelTriageLedgerLine extends SentinelTriageLedgerRecord {
  source: "sentinel"
  applied: false
}

/** Append exactly one observation line. Never throws and never records the
 *  event summary or `data`: the ledger carries identifiers and classification
 *  only. */
export function writeSentinelTriageLedger(path: string, record: SentinelTriageLedgerRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const line: SentinelTriageLedgerLine = {
      ts: record.ts,
      source: "sentinel",
      applied: false,
      decision: record.decision,
      rule: record.rule,
      target: record.target,
      sentinelId: record.sentinelId,
      eventId: record.eventId,
      type: record.type,
      subject: record.subject,
      urgency: record.urgency,
    }
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 })
  } catch {
    // Observation only: a failed ledger write must never affect delivery.
  }
}
