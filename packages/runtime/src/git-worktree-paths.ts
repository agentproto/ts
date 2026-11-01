/**
 * Filesystem-only git worktree classification for installed-app dirs: is a
 * path inside a LINKED worktree (an ephemeral checkout, removed with its
 * branch), and which main worktree does it belong to. No `git` subprocess:
 * this runs on the install path and at daemon boot, and a `.git` file plus
 * the admin dir's `commondir` say everything needed.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** The nearest ancestor of `dir` (itself included) holding a `.git` entry. */
function findDotGit(dir: string): { root: string; dotGit: string } | undefined {
  let cur = resolve(dir)
  for (;;) {
    const dotGit = join(cur, ".git")
    if (existsSync(dotGit)) return { root: cur, dotGit }
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
}

export interface LinkedWorktree {
  /** Root of the linked worktree that contains the path. */
  readonly worktreeRoot: string
  /** The repo's main worktree, or undefined for a bare repo's worktree. */
  readonly mainWorktree: string | undefined
}

/**
 * When `dir` lies inside a linked git worktree (`git worktree add`), its
 * root and the repo's main worktree; undefined for a main worktree, a
 * submodule (a `.git` file whose admin dir has no `commondir`), or a path
 * outside any repo.
 */
export function linkedWorktreeOf(dir: string): LinkedWorktree | undefined {
  const found = findDotGit(dir)
  if (found === undefined) return undefined
  try {
    if (statSync(found.dotGit).isDirectory()) return undefined
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(found.dotGit, "utf8"))
    if (m === null) return undefined
    const adminDir = resolve(found.root, m[1]!.trim())
    const commondirFile = join(adminDir, "commondir")
    if (!existsSync(commondirFile)) return undefined
    const commonDir = resolve(adminDir, readFileSync(commondirFile, "utf8").trim())
    return {
      worktreeRoot: found.root,
      mainWorktree: basename(commonDir) === ".git" ? dirname(commonDir) : undefined,
    }
  } catch {
    return undefined
  }
}

/** The main worktree of the repo containing `dir` (whether `dir` is in the
 *  main worktree or a linked one), or undefined outside any repo. */
export function mainWorktreeOf(dir: string): string | undefined {
  const found = findDotGit(dir)
  if (found === undefined) return undefined
  try {
    if (statSync(found.dotGit).isDirectory()) return found.root
  } catch {
    return undefined
  }
  return linkedWorktreeOf(dir)?.mainWorktree
}
