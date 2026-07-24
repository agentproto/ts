/**
 * Pure helpers for the worktree clean-up flow (agentproto.cleanWorktrees) — no
 * vscode import, so unit-testable. The command (worktreeCleanup.ts) does the
 * dry-run → confirm → apply round-trip and the I/O; the classification and
 * summary logic lives here.
 */

import type { WorktreeGcOutcomeView, WorktreeGcPlanEntryView } from "../client/types.js"

export interface GcPlanPartition {
  /** Safe to remove: merged, clean, no open PR, no live session. */
  reclaim: WorktreeGcPlanEntryView[]
  /** Dirty — removed only with `salvageDirty`; surfaced but not auto-removed. */
  salvage: WorktreeGcPlanEntryView[]
  /** Kept: an open PR or a live session pins it. */
  hold: WorktreeGcPlanEntryView[]
}

export function partitionGcPlan(plan: readonly WorktreeGcPlanEntryView[]): GcPlanPartition {
  return {
    reclaim: plan.filter(e => e.class === "reclaim"),
    salvage: plan.filter(e => e.class === "salvage"),
    hold: plan.filter(e => e.class === "hold"),
  }
}

/** Last path segment of a `/`-separated path. */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const idx = trimmed.lastIndexOf("/")
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Compact one-line label for a worktree in a list: "branch — dir" (or just
 *  the dir when the worktree is detached / has no branch). */
export function worktreeLabel(entry: WorktreeGcPlanEntryView): string {
  const dir = basenameOf(entry.path) || entry.path
  return entry.branch ? `${entry.branch} — ${dir}` : dir
}

/** One-line summary of a dry-run plan — what would happen if applied. */
export function gcPlanSummary(part: GcPlanPartition): string {
  const parts = [`${part.reclaim.length} to reclaim`]
  if (part.salvage.length > 0) parts.push(`${part.salvage.length} dirty (kept)`)
  if (part.hold.length > 0) parts.push(`${part.hold.length} held (open PR / live)`)
  return parts.join(" · ")
}

const OUTCOME_ORDER: readonly WorktreeGcOutcomeView["result"][] = [
  "reclaimed",
  "salvaged",
  "held",
  "skipped-dirty",
  "aborted-reclassified",
  "aborted-vanished",
  "failed",
]

export function gcOutcomeCounts(
  outcomes: readonly WorktreeGcOutcomeView[],
): Partial<Record<WorktreeGcOutcomeView["result"], number>> {
  const counts: Partial<Record<WorktreeGcOutcomeView["result"], number>> = {}
  for (const o of outcomes) counts[o.result] = (counts[o.result] ?? 0) + 1
  return counts
}

/** Human summary of an apply run, ordered most-relevant-first. */
export function gcOutcomeSummary(outcomes: readonly WorktreeGcOutcomeView[]): string {
  const counts = gcOutcomeCounts(outcomes)
  const parts = OUTCOME_ORDER.filter(k => counts[k]).map(k => `${counts[k]} ${k}`)
  return parts.length > 0 ? parts.join(" · ") : "nothing to do"
}

/** True when a thrown daemon error means the gc runner isn't wired (501). */
export function isWorktreeGcNotConfigured(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("worktree_gc_not_configured") || msg.includes("HTTP 501")
}
