import type { GhPull } from "./types.js"

/** A later PR (or commit) that might revert the pull under inspection. */
export interface RevertCandidate {
  title?: string
  body?: string
}

/**
 * Whether any candidate reverts `pull`: either its title is exactly
 * `Revert "<pull title>"` (GitHub's revert-PR format; a trailing ` (#N)` on the
 * quoted title is tolerated), or its body says `This reverts commit <sha>` for
 * the pull's merge commit. A generic "This reverts commit" with another sha does
 * not count. The caller is responsible for passing only candidates merged AFTER
 * the pull.
 */
export function isRevertOf(pull: GhPull, candidates: readonly RevertCandidate[]): boolean {
  const sha = pull.mergeCommitSha?.toLowerCase()
  return candidates.some((c) => {
    const quoted = /^Revert "(.*)"(?: \(#\d+\))?$/.exec(c.title?.trim() ?? "")?.[1]
    if (quoted !== undefined && (quoted === pull.title || quoted === `${pull.title} (#${pull.number})`)) return true
    if (sha) {
      for (const m of (c.body ?? "").matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) {
        const found = (m[1] ?? "").toLowerCase()
        if (found && (sha.startsWith(found) || found.startsWith(sha))) return true
      }
    }
    return false
  })
}
