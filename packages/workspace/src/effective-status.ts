/**
 * AIP-34 §Status — a node's EFFECTIVE status is the most restrictive status
 * along its ancestor chain (archived > paused > active); a child is never
 * more active than an ancestor. The node's own declared `status` (as written
 * in its WORKSPACE.md) is untouched by this — only the derived, reported
 * value changes.
 *
 * Pure and tree-shape-agnostic on purpose: `checker/check-tree.ts` is the
 * only place that actually walks `WORKSPACE.md` nodes, so this just takes
 * the already-resolved ancestor chain (nearest parent first, root last) and
 * returns the resolved status plus which ancestor (if any) is responsible —
 * "responsible" meaning the nearest ancestor whose own status already
 * reaches the effective restrictiveness, so a diamond of e.g. two `archived`
 * ancestors reports the nearer one.
 */

import type { WorkspaceStatus } from "./schema.js"

const RESTRICTIVENESS: Record<WorkspaceStatus, number> = {
  active: 0,
  paused: 1,
  archived: 2,
}

export interface EffectiveStatusAncestor {
  id: string
  status: WorkspaceStatus | undefined
}

export interface EffectiveStatusResult {
  effectiveStatus: WorkspaceStatus
  /**
   * id of the ancestor the effective status is inherited from — set only
   * when the effective status is strictly more restrictive than the node's
   * OWN declared status (i.e. it differs from what's written in the node's
   * file). Undefined when the node's own status already explains it.
   */
  statusInheritedFrom?: string
}

/**
 * @param ownStatus the node's own declared status; `undefined` means the
 *   schema default (`active`), same as a missing `status:` key.
 * @param ancestors the node's ancestor chain, NEAREST PARENT FIRST (root
 *   last) — matches how `check-tree.ts` already walks `parentDir` for
 *   budget aggregation. Each ancestor's `status` is `undefined` for the same
 *   missing-means-active reason.
 */
export function computeEffectiveStatus(
  ownStatus: WorkspaceStatus | undefined,
  ancestors: readonly EffectiveStatusAncestor[],
): EffectiveStatusResult {
  let effectiveStatus: WorkspaceStatus = ownStatus ?? "active"
  let statusInheritedFrom: string | undefined

  for (const ancestor of ancestors) {
    const ancestorStatus = ancestor.status ?? "active"
    if (RESTRICTIVENESS[ancestorStatus] > RESTRICTIVENESS[effectiveStatus]) {
      effectiveStatus = ancestorStatus
      statusInheritedFrom = ancestor.id
    }
  }

  return statusInheritedFrom ? { effectiveStatus, statusInheritedFrom } : { effectiveStatus }
}
