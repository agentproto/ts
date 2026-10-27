/**
 * Guard for the verbs that delete a worktree's branch on the way out
 * (`worktree archive` / `rm`). Removing the worktree is recoverable; deleting
 * a branch whose commits exist nowhere else is not (only the reflog keeps
 * them). So the branch is deleted only when its tip is proven merged into
 * base with `branch gc`'s ladder (ancestor, squash, patch, content), and kept
 * otherwise, unless the caller forces it.
 */

import { classifyTipAgainstBase } from "./branch-gc.js"
import { execArgv } from "./exec.js"

export type BranchDeletionAction = "deleted" | "kept"

export interface BranchDeletionDecision {
  action: BranchDeletionAction
  /** Why, in one line a human can read in the CLI output or MANIFEST.json. */
  reason: string
  /** Commits on the tip reachable from no remote-tracking ref; `null` when it could not be counted. */
  commitsNotOnAnyRemote: number | null
}

export interface DecideBranchDeletionInput {
  repoRoot: string
  baseRef: string
  branch: string
  tipSha: string
  /** `--keep-branch`: the caller already chose to keep it. */
  keepBranch?: boolean
  /** `--force`: delete even when the tip is not proven merged. */
  force?: boolean
}

async function commitsNotOnAnyRemote(repoRoot: string, tipSha: string): Promise<number | null> {
  const res = await execArgv("git", ["-C", repoRoot, "rev-list", "--count", tipSha, "--not", "--remotes"], repoRoot)
  if (res.exitCode !== 0) return null
  const n = Number(res.stdout.trim())
  return Number.isFinite(n) ? n : null
}

export async function decideBranchDeletion(input: DecideBranchDeletionInput): Promise<BranchDeletionDecision> {
  const localOnly = await commitsNotOnAnyRemote(input.repoRoot, input.tipSha)
  if (input.keepBranch) return { action: "kept", reason: "--keep-branch", commitsNotOnAnyRemote: localOnly }
  let proven: string | null = null
  try {
    const tip = await classifyTipAgainstBase(input.repoRoot, input.baseRef, input.tipSha)
    if (tip.status !== "unmerged") proven = tip.status
  } catch {
    // An unresolvable base or a git error proves nothing: treat as unmerged.
  }
  if (proven) return { action: "deleted", reason: `merged into ${input.baseRef} (${proven})`, commitsNotOnAnyRemote: localOnly }
  const unproven = `not proven merged into ${input.baseRef}`
  const remoteNote =
    localOnly === null ? "" : localOnly === 0 ? ", all commits exist on a remote" : `, ${localOnly} commit(s) exist on no remote`
  if (input.force) {
    return { action: "deleted", reason: `${unproven}${remoteNote}; deleted because of --force`, commitsNotOnAnyRemote: localOnly }
  }
  return { action: "kept", reason: `${unproven}${remoteNote}; pass --force to delete it anyway`, commitsNotOnAnyRemote: localOnly }
}
