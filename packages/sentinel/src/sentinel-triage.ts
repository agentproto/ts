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
 * 1. GitHub triage table (event class to delivery). It runs BEFORE the generic
 *    rules below, so it deliberately overrides them for the GitHub event
 *    classes it covers: a terminal `github.pull_request.closed` (merged or
 *    not) is `fyi` rather than `wake`, and a failing check, workflow run or
 *    `changes_requested` review records `github-triage-table` rather than
 *    `failure`.
 * 2. `terminal`: an event that ends its subject's lifecycle always wakes,
 *    unless a GitHub triage row above already classified it.
 * 3. `failure`: a failing verdict (conclusion/state) always wakes, because a
 *    real failure must never be demoted by an earlier pending tick on the
 *    same head, unless a GitHub triage row above already classified it.
 * 4. `coalesced-repeat`: the same `(target, triage key)` was first classified
 *    within the last 10 minutes, so this one is only `fyi`.
 * 5. `default`: everything else wakes.
 *
 * The triage key is the delivery coalesce key plus the event's verdict when
 * it carries one, so a different conclusion/state on the same head is not a
 * repeat. Keys are recorded by the caller AFTER a successful delivery, so an
 * event never counts as a repeat of itself and a failed send is not recorded
 * as seen. {@link RecentKeys} is a bounded map (1000 entries by default) that
 * evicts the oldest insertion when full; a repeat does not refresh its
 * first-seen time, so the window is fixed rather than sliding.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { TriageDecision, MessageUrgency } from "./local-types.js"
import { coalesceKeyFor } from "./sentinel-coalesce.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"

/** How recently the same `(target, key)` must have been seen to count as a
 *  coalesced repeat. */
export const SENTINEL_TRIAGE_REPEAT_WINDOW_MS = 10 * 60 * 1000

/** Default bound on the recent-key map. */
export const DEFAULT_RECENT_KEYS_CAP = 1000

export type SentinelTriageRule = "terminal" | "failure" | "coalesced-repeat" | "default" | "github-triage-table"

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

/** Bounded insertion-ordered map of recently classified triage keys.
 *  Re-recording a key that is still inside the window keeps its first-seen
 *  timestamp and position; recording past the cap evicts the oldest key. */
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
    const at = this.entries.get(id)
    if (at !== undefined && now >= at && now - at < SENTINEL_TRIAGE_REPEAT_WINDOW_MS) return
    this.entries.delete(id)
    this.entries.set(id, now)
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

export type SentinelGithubTriageEventClass =
  | "github.check_suite.completed"
  | "github.workflow_run.completed"
  | "github.pull_request_review.submitted"
  | "github.pull_request.closed"
  | "github.pull_request.synchronize"
  | "github.issue_comment.created"

export interface SentinelGithubTriageRuleRow {
  eventClass: SentinelGithubTriageEventClass
  match: (event: SentinelEvent) => boolean
  decision: TriageDecision
}

export const SENTINEL_GITHUB_TRIAGE_RULE_TABLE: readonly SentinelGithubTriageRuleRow[] = [
  {
    eventClass: "github.check_suite.completed",
    match: (event: SentinelEvent) => {
      const v = verdictOf(event)
      return v === "failure" || v === "error" || v === "cancelled" || v === "timed_out" || v === "action_required"
    },
    decision: "wake",
  },
  {
    eventClass: "github.workflow_run.completed",
    match: (event: SentinelEvent) => {
      const v = verdictOf(event)
      return v === "failure" || v === "error" || v === "cancelled" || v === "timed_out" || v === "action_required"
    },
    decision: "wake",
  },
  {
    eventClass: "github.pull_request_review.submitted",
    match: (event: SentinelEvent) => verdictOf(event) === "changes_requested",
    decision: "wake",
  },
  {
    eventClass: "github.issue_comment.created",
    match: (event: SentinelEvent) => {
      const actor = typeof event.data.actor === "string" ? event.data.actor : ""
      return !actor.toLowerCase().endsWith("[bot]")
    },
    decision: "wake",
  },
  {
    eventClass: "github.issue_comment.created",
    match: (event: SentinelEvent) => {
      const actor = typeof event.data.actor === "string" ? event.data.actor : ""
      return actor.toLowerCase().endsWith("[bot]")
    },
    decision: "fyi",
  },
  {
    eventClass: "github.pull_request.closed",
    match: (event: SentinelEvent) => event.data.merged === false,
    decision: "fyi",
  },
  {
    eventClass: "github.check_suite.completed",
    match: (event: SentinelEvent) => {
      const v = verdictOf(event)
      return v === "success" || v === "neutral" || v === "skipped"
    },
    decision: "fyi",
  },
  {
    eventClass: "github.workflow_run.completed",
    match: (event: SentinelEvent) => {
      const v = verdictOf(event)
      return v === "success" || v === "neutral" || v === "skipped"
    },
    decision: "fyi",
  },
  {
    eventClass: "github.pull_request_review.submitted",
    match: (event: SentinelEvent) => {
      const v = verdictOf(event)
      return v === "approved" || v === "commented"
    },
    decision: "fyi",
  },
  {
    eventClass: "github.pull_request.closed",
    match: (event: SentinelEvent) => event.data.merged === true,
    decision: "fyi",
  },
  {
    eventClass: "github.pull_request.synchronize",
    match: () => true,
    decision: "fyi",
  },
]

const FAILURE_VERDICTS: ReadonlySet<string> = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  // Verdicts that need the recipient to act, not just know: a review asking
  // for changes, a check suite waiting on a human.
  "changes_requested",
  "action_required",
])

/** The event's own verdict: `conclusion` (check suites/runs, workflow runs)
 *  or `state` (statuses, reviews), lowercased because providers disagree on
 *  casing (webhook `changes_requested`, GraphQL `CHANGES_REQUESTED`), or ""
 *  when it carries neither. */
function verdictOf(event: SentinelEvent): string {
  const conclusion = event.data.conclusion
  if (typeof conclusion === "string") return conclusion.toLowerCase()
  const state = event.data.state
  return typeof state === "string" ? state.toLowerCase() : ""
}

/** Triage repeat key: the delivery coalesce key plus the verdict, so a
 *  different conclusion/state on the same head is a different event. */
export function sentinelTriageKeyFor(event: SentinelEvent): string | undefined {
  const key = coalesceKeyFor(event)
  return key === undefined ? undefined : `${key}|${verdictOf(event)}`
}

function isFailureEvent(event: SentinelEvent): boolean {
  return event.terminal !== true && FAILURE_VERDICTS.has(verdictOf(event))
}

/** Classify one event without applying anything. The caller records the
 *  triage key after a successful delivery so a failed send is not counted
 *  as seen and an event never counts as a repeat of itself. */
export function classifySentinelEvent(
  event: SentinelEvent,
  input: SentinelTriageInput,
): SentinelTriageResult {
  const key = sentinelTriageKeyFor(event)

  for (const row of SENTINEL_GITHUB_TRIAGE_RULE_TABLE) {
    if (row.eventClass === event.type && row.match(event)) {
      return { decision: row.decision, rule: "github-triage-table" }
    }
  }

  if (event.terminal === true) {
    return { decision: "wake", rule: "terminal" }
  } else if (isFailureEvent(event)) {
    return { decision: "wake", rule: "failure" }
  } else if (key !== undefined && input.recent.has(input.target, key, input.now)) {
    return { decision: "fyi", rule: "coalesced-repeat" }
  } else {
    return { decision: "wake", rule: "default" }
  }
}

/** Record the triage key for a successfully delivered event. */
export function recordSentinelTriageKey(
  event: SentinelEvent,
  input: Pick<SentinelTriageInput, "target" | "now" | "recent">,
): void {
  const key = sentinelTriageKeyFor(event)
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
  eventTs?: string
  key?: string
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
      ...(record.eventTs !== undefined ? { eventTs: record.eventTs } : {}),
      ...(record.key !== undefined ? { key: record.key } : {}),
    }
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 })
  } catch {
    // Observation only: a failed ledger write must never affect delivery.
  }
}
