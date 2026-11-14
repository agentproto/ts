/**
 * Observation-only triage for sentinel deliveries.
 *
 * This module never changes what a sentinel delivers. It answers the
 * question a future triage stage would ask before waking the target, and the
 * runtime records that answer in a JSONL ledger (`applied: false`) beside the
 * delivery it actually performs. The ledger is training data for that later
 * stage, not a gate.
 *
 * Generic rules live here; producer knowledge (GitHub verdicts, the explicit
 * event-class table and its coalesce keys) is registered by
 * `@agentproto/delivery-github`. Rules are checked in order:
 * 1. `terminal`: an event that ends its subject's lifecycle always wakes.
 * 2. `coalesced-repeat`: the same `(target, repeatKey)` was first seen within
 *    the last 10 minutes, so this one is only `fyi`.
 * 3. the registered classifier registry: first non-declining classifier wins;
 *    no match is the default level (`levelHint ?? 2` -> wake).
 *
 * A producer sets `Envelope.repeatKey` when it is safe to coalesce. The
 * GitHub producer deliberately sets none on failures, so a repeated failure
 * on the same head always wakes. Keys are recorded by the caller AFTER a
 * successful delivery, so an event never counts as a repeat of itself and a
 * failed send is not recorded as seen. {@link RecentKeys} is a bounded map
 * (1000 entries by default) that evicts the oldest insertion when full; a
 * repeat does not refresh its first-seen time, so the window is fixed rather
 * than sliding.
 */

import {
  DEFAULT_RECENT_KEYS_CAP,
  REPEAT_WINDOW_MS,
  RecentKeys,
  createClassifierRegistry,
  type Classifier,
  type Envelope,
  type Level,
} from "@agentproto/delivery"

import type { TriageDecision } from "./local-types.js"
import type { SentinelEvent } from "./sentinel-providers/types.js"

/** How recently the same `(target, key)` must have been seen to count as a
 *  coalesced repeat. */
export const SENTINEL_TRIAGE_REPEAT_WINDOW_MS = REPEAT_WINDOW_MS

export { DEFAULT_RECENT_KEYS_CAP, RecentKeys }

export type SentinelTriageRule = string

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

const classifiers: Classifier[] = []
const repeatKeyResolvers: Array<(event: Envelope) => string | undefined> = []

/** Register a classifier for sentinel triage. Idempotent by classifier id so
 *  a producer module can be imported more than once. */
export function registerSentinelClassifier(classifier: Classifier): () => void {
  const existing = classifiers.findIndex(candidate => candidate.id === classifier.id)
  if (existing !== -1) classifiers.splice(existing, 1)
  classifiers.push(classifier)
  return () => {
    const idx = classifiers.findIndex(candidate => candidate === classifier)
    if (idx !== -1) classifiers.splice(idx, 1)
  }
}

export function listSentinelClassifiers(): readonly Classifier[] {
  return [...classifiers]
}

/** Register a producer's repeat-key resolver. The first resolver that claims
 *  an event (returns a key) wins; none means the event never coalesces. */
export function registerSentinelRepeatKey(
  resolver: (event: Envelope) => string | undefined,
): () => void {
  repeatKeyResolvers.push(resolver)
  return () => {
    const idx = repeatKeyResolvers.indexOf(resolver)
    if (idx !== -1) repeatKeyResolvers.splice(idx, 1)
  }
}

/** The event with the producer's repeat key attached, when one is known. */
export function sentinelEnvelopeFor<E extends SentinelEvent>(event: E): E & Envelope {
  if (event.repeatKey !== undefined) return event
  for (const resolve of repeatKeyResolvers) {
    const repeatKey = resolve(event)
    if (repeatKey !== undefined) return { ...event, repeatKey }
  }
  return event
}

function decisionForLevel(level: Level): TriageDecision {
  if (level >= 2) return "wake"
  if (level === 1) return "fyi"
  return "drop"
}

/** Classify one event without applying anything. The caller records the
 *  triage key after a successful delivery so a failed send is not counted
 *  as seen and an event never counts as a repeat of itself. */
export function classifySentinelEvent(
  event: SentinelEvent,
  input: SentinelTriageInput,
): SentinelTriageResult {
  const envelope = sentinelEnvelopeFor(event)

  if (event.terminal === true) {
    return { decision: "wake", rule: "terminal" }
  }
  if (
    envelope.repeatKey !== undefined &&
    input.recent.has(input.target, envelope.repeatKey, input.now)
  ) {
    return { decision: "fyi", rule: "coalesced-repeat" }
  }

  const { level, rule } = createClassifierRegistry(classifiers).classify(envelope, {
    targetId: input.target,
  })
  return { decision: decisionForLevel(level), rule }
}

/** Record the repeat key for a successfully delivered event. */
export function recordSentinelTriageKey(
  event: SentinelEvent,
  input: Pick<SentinelTriageInput, "target" | "now" | "recent">,
): void {
  const key = sentinelEnvelopeFor(event).repeatKey
  if (key !== undefined) {
    input.recent.record(input.target, key, input.now)
  }
}
