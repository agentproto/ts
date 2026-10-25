/**
 * Composable coalescing rules for sentinel -> session-queue delivery
 * (AIP-60 §4's "one event per thing that happened", not per poll tick).
 *
 * A sentinel event that lands while the target session is busy becomes a
 * queued prompt (`sessions.ts` `enqueuePrompt`'s queue arm). Without a key,
 * a burst about the SAME underlying thing (5 partial `check_suite` ticks,
 * a push, more checks) parks N separate notices. This module is the pure
 * "which queue slot does this event belong in" half: a rule registry, one
 * rule per event family, so adding a family never touches the runtime
 * wiring — `sentinel-runtime.ts` calls {@link coalesceKeyFor} and hands the
 * result through as `enqueuePrompt`'s `coalesceKey`; the replace-in-place
 * itself lives in `sessions.ts`.
 *
 * Pure, no I/O. The registry is module-level on purpose (default rules are
 * registered at import; tests may add/undo their own with
 * {@link registerSentinelCoalesceRule}'s unregister handle).
 */

import type { SentinelEvent } from "./sentinel-providers/types.js"

/** One rule = one event family. Add a family by registering a rule; nothing
 *  else in the runtime needs to change. */
export interface SentinelCoalesceRule {
  /** Stable id for logs/tests. */
  id: string
  /** Event types this rule covers. Exact match, or a prefix ending in `*`
   *  (e.g. `github.check_suite.*`). */
  types: readonly string[]
  /** Events yielding the SAME key replace each other while still queued
   *  (newest wins, keeps the older item's queue position). Return undefined to
   *  never coalesce this particular event. */
  key(event: SentinelEvent): string | undefined
}

/** Exact match, or a prefix match for a `*`-suffixed pattern. A bare `*`
 *  matches everything. */
export function matchesType(pattern: string, type: string): boolean {
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

const rules: SentinelCoalesceRule[] = []

export function registerSentinelCoalesceRule(rule: SentinelCoalesceRule): () => void {
  rules.push(rule)
  return () => {
    const idx = rules.indexOf(rule)
    if (idx !== -1) rules.splice(idx, 1)
  }
}

export function listSentinelCoalesceRules(): readonly SentinelCoalesceRule[] {
  return [...rules]
}

/** First matching rule wins (registration order; defaults registered first).
 *  The result is always namespaced `sentinel:<ruleId>:<key>` so it can never
 *  collide with a non-sentinel queue key. */
export function coalesceKeyFor(event: SentinelEvent): string | undefined {
  for (const rule of rules) {
    if (!rule.types.some(pattern => matchesType(pattern, event.type))) continue
    const key = rule.key(event)
    return key === undefined ? undefined : `sentinel:${rule.id}:${key}`
  }
  return undefined
}

/** `headSha` (local-gh / normalize's camelCase) or `head_sha` (GitHub's own
 *  webhook spelling); anything else counts as "no sha" so a family that
 *  emits neither still coalesces per subject. */
function headShaOf(event: SentinelEvent): string {
  const data = event.data
  const raw = data.headSha ?? data.head_sha
  return typeof raw === "string" ? raw : ""
}

// ── Default rules (registration order matters — first match wins) ────

/** CI verdicts of every shape collapse per (PR, head) — one pending queue
 *  slot per commit, however many partial polls reported on it. */
registerSentinelCoalesceRule({
  id: "github-ci",
  types: ["github.check_suite.*", "github.workflow_run.*", "github.status*", "github.check_run.*"],
  key(event): string {
    return `ci:${event.subject}:${headShaOf(event)}`
  },
})

/** One push per PR-head is one queue slot, however it arrives. */
registerSentinelCoalesceRule({
  id: "github-push",
  types: ["github.pull_request.synchronize"],
  key(event): string {
    return `push:${event.subject}`
  },
})
