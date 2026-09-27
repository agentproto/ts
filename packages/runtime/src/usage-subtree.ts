/**
 * Subtree usage rollup: one session's own usage plus the summed usage of
 * every session it (transitively) spawned — the shape `session_usage
 * { includeSubtree: true }` and `GET /sessions/:id/usage?includeSubtree=1`
 * return.
 *
 * Pure over a descriptor list (walked by `parentSessionId`, the same graph
 * `collectSubtree` uses for orchestrator scoping), so it's unit-testable
 * without a registry.
 *
 * Absent stays absent: a total is the sum of the sessions that REPORT the
 * field, and is omitted entirely when none of them do — a subtree of
 * cost-less sessions never reads as a measured $0.
 */

import { collectSubtree } from "./agent-tools.js"
import type { SessionDescriptor } from "./sessions.js"
import { projectSessionUsage, type SessionUsage } from "./usage.js"

/** Summed usage across the root and all its descendants. */
export interface SubtreeUsageTotals {
  /** Sessions counted, root included. */
  sessions: number
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One direct child of the root, with that child's OWN usage (its own
 *  descendants roll up into `subtree`, not here). */
export interface SubtreeChildUsage {
  id: string
  label?: string
  status: SessionDescriptor["status"]
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
}

export interface SessionUsageWithSubtree {
  self: SessionUsage
  subtree: SubtreeUsageTotals
  children: SubtreeChildUsage[]
}

const SUMMED_KEYS = [
  "costUsd",
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const satisfies readonly (keyof SubtreeUsageTotals)[]

/**
 * Roll `root`'s usage up over its subtree. `all` should be the FULL
 * descriptor list (archived included) so an archived intermediate session
 * doesn't sever the parent→child chain.
 */
export function rollupSessionSubtree(
  root: SessionDescriptor,
  all: readonly SessionDescriptor[],
): SessionUsageWithSubtree {
  const byId = new Map(all.map(d => [d.id, d]))
  const ids = collectSubtree(root.id, all)

  const subtree: SubtreeUsageTotals = { sessions: 0 }
  for (const id of ids) {
    const desc = id === root.id ? root : byId.get(id)
    if (!desc) continue
    subtree.sessions += 1
    const usage = projectSessionUsage(desc)
    for (const k of SUMMED_KEYS) {
      const v = usage[k]
      if (typeof v === "number") subtree[k] = (subtree[k] ?? 0) + v
    }
  }

  const children: SubtreeChildUsage[] = all
    .filter(d => d.parentSessionId === root.id && d.id !== root.id)
    .map(d => {
      const usage = projectSessionUsage(d)
      return {
        id: d.id,
        ...(d.label !== undefined ? { label: d.label } : {}),
        status: d.status,
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        ...(usage.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
        ...(usage.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
      }
    })

  return { self: projectSessionUsage(root), subtree, children }
}
