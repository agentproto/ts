/**
 * Resolves the git worktree a session's `cwd` sits in, so the spawn paths in
 * `sessions.ts` can record the session→worktree edge on the descriptor
 * (`SessionDescriptor.worktreePath` / `worktreeId`).
 *
 * Recorded at spawn rather than derived at read time because the edge is not
 * reconstructable later: a worktree removed after the fact leaves nothing on
 * disk to re-resolve, and matching a session's `cwd` against a path prefix —
 * what `@agentproto/worktree`'s provenance join has to do today
 * (`packages/worktree/src/provenance.ts:88`) — cannot tell two generations of
 * worktree at the same path apart.
 *
 * Read straight off git's on-disk layout instead of shelling out to `git
 * rev-parse --git-dir`: every spawn path here is synchronous (`spawnAgent`
 * returns a descriptor, not a promise), so a subprocess would mean either
 * blocking the daemon's event loop per spawn or back-filling the field
 * afterwards. The layout is documented, stable API (gitrepository-layout(5)),
 * which makes the sync read exact — see `readWorktreeGitDir`.
 */

import { readFileSync, statSync, type Stats } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"

/** The provision marker's one field this module needs. Written by
 *  `worktree.provision` (`packages/worktree/src/provider/bodies/
 *  provision-worktree.body.ts:31`); full schema at
 *  `packages/worktree/src/provenance.ts:94`. Deliberately read as a file
 *  rather than through `@agentproto/worktree`: runtime doesn't depend on that
 *  package (the edge would drag in driver/harness/workflow-runtime for one
 *  small JSON read), and its reader there is async. The file IS the contract
 *  — provenance's own join already treats it as the source of truth. */
const markerSchema = z.object({ worktreeId: z.string() })

export interface WorktreeIdentity {
  /** Absolute path of the worktree's ROOT — the directory holding the `.git`
   *  link — not the session's `cwd`, which may be a subdirectory of it. */
  worktreePath: string
  /** The worktree's generation id, when it carries a provision marker.
   *  Absent for a worktree created by a bare `git worktree add`. */
  worktreeId?: string
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * Resolves `<dir>/.git` to the admin directory of a LINKED worktree, or
 * `undefined` if `dir` is anything else. Git's layout is the discriminator:
 *   - a normal checkout's `.git` is a directory (handled by the caller);
 *   - a linked worktree's `.git` is a file holding `gitdir: <admin-dir>`,
 *     where the admin dir is `<common-git-dir>/worktrees/<name>` and carries
 *     its own `gitdir` file pointing back at this very `.git` file.
 *
 * That back-pointer is what makes the check exact rather than a guess: a
 * submodule's `.git` is also a `gitdir:` file (pointing into
 * `<super>/.git/modules/<name>`), and only a linked worktree's admin dir has
 * `gitdir` in it. Without the check every submodule checkout would report
 * itself as a worktree.
 */
function readWorktreeGitDir(dir: string): string | undefined {
  const link = ((): string | undefined => {
    try {
      return readFileSync(join(dir, ".git"), "utf8")
    } catch {
      return undefined
    }
  })()
  if (link === undefined) return undefined
  const target = /^gitdir:\s*(.+)$/m.exec(link)?.[1]?.trim()
  if (!target) return undefined
  // Git writes an absolute path by default but supports a relative one
  // (`worktree add --relative-paths`); git resolves it against the directory
  // holding the `.git` file, so do the same.
  const gitDir = isAbsolute(target) ? target : resolve(dir, target)
  return statOrUndefined(join(gitDir, "gitdir"))?.isFile() === true ? gitDir : undefined
}

/** The provision marker's `worktreeId`, or `undefined` when the worktree has
 *  no marker (a hand-rolled `git worktree add`) or it's unreadable/malformed
 *  — never a throw: a spawn must not fail over bookkeeping. */
function readWorktreeId(gitDir: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(join(gitDir, "agentproto-worktree.json"), "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = markerSchema.safeParse(parsed)
  return result.success ? result.data.worktreeId : undefined
}

/**
 * The worktree containing `cwd`, or `undefined` when there is none — a plain
 * checkout, a directory outside any repo, or a path that doesn't exist.
 *
 * Walks up from `cwd` because a session is often spawned in a subdirectory of
 * the worktree root. The FIRST `.git` found wins and terminates the walk
 * either way: git's own repository discovery stops at the nearest one, so a
 * plain checkout nested inside a worktree belongs to itself, not to the
 * enclosing tree.
 */
export function resolveWorktreeIdentity(cwd: string): WorktreeIdentity | undefined {
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = statOrUndefined(join(dir, ".git"))
    if (dotGit) {
      // A directory means a normal checkout: in a repo, but not a worktree.
      if (!dotGit.isFile()) return undefined
      const gitDir = readWorktreeGitDir(dir)
      if (gitDir === undefined) return undefined
      const worktreeId = readWorktreeId(gitDir)
      return worktreeId === undefined
        ? { worktreePath: dir }
        : { worktreePath: dir, worktreeId }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined // filesystem root — no repo above.
    dir = parent
  }
}
