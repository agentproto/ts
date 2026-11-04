/**
 * Composable coalescing rules for sentinel -> session-queue delivery
 * (AIP-60 §4's "one event per thing that happened", not per poll tick).
 *
 * A sentinel event that lands while the target session is busy becomes a
 * queued prompt (`sessions.ts` `enqueuePrompt`'s queue arm). Without a key,
 * a burst about the SAME underlying thing parks N separate notices. This
 * module is the pure "which queue slot does this event belong in" half: a
 * rule registry, one rule per event family, so adding a family never touches
 * the runtime wiring: `sentinel-runtime.ts` calls {@link coalesceKeyFor} and
 * hands the result through as `enqueuePrompt`'s `coalesceKey`; the
 * replace-in-place itself lives in `sessions.ts`.
 *
 * Pure, no I/O. The registry is module-level on purpose; producer modules
 * (for example `@agentproto/delivery-github`) register their default rules
 * at composition time, and tests may add/undo their own with
 * {@link registerSentinelCoalesceRule}'s unregister handle.
 */

import type { Envelope } from "@agentproto/delivery"

/** One rule = one event family. Add a family by registering a rule; nothing
 *  else in the runtime needs to change. */
export interface SentinelCoalesceRule {
  /** Stable id for logs/tests. */
  id: string
  /** Event types this rule covers. Exact match, or a prefix ending in `*`. */
  types: readonly string[]
  /** Events yielding the SAME key replace each other while still queued
   *  (newest wins, keeps the older item's queue position). Return undefined to
   *  never coalesce this particular event. */
  key(event: Envelope): string | undefined
}

/** Exact match, or a prefix match for a `*`-suffixed pattern. A bare `*`
 *  matches everything. */
export function matchesType(pattern: string, type: string): boolean {
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

const rules: SentinelCoalesceRule[] = []

export function registerSentinelCoalesceRule(rule: SentinelCoalesceRule): () => void {
  const existing = rules.findIndex(candidate => candidate.id === rule.id)
  if (existing !== -1) rules.splice(existing, 1)
  rules.push(rule)
  return () => {
    const idx = rules.findIndex(candidate => candidate === rule)
    if (idx !== -1) rules.splice(idx, 1)
  }
}

export function listSentinelCoalesceRules(): readonly SentinelCoalesceRule[] {
  return [...rules]
}

/** First matching rule wins (registration order; producer defaults registered
 *  first). The result is always namespaced `sentinel:<ruleId>:<key>` so it can
 *  never collide with a non-sentinel queue key. */
export function coalesceKeyFor(event: Envelope): string | undefined {
  for (const rule of rules) {
    if (!rule.types.some(pattern => matchesType(pattern, event.type))) continue
    const key = rule.key(event)
    return key === undefined ? undefined : `sentinel:${rule.id}:${key}`
  }
  return undefined
}
