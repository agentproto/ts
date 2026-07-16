/**
 * Host-side file listing for `@file` mentions, scoped to a session's cwd.
 *
 * `git ls-files` is the source of truth when the cwd is a repo: it honors
 * `.gitignore` for free (DECISIONS #2) and is one cheap spawn. `--cached
 * --others --exclude-standard` = tracked + untracked-but-not-ignored, so a
 * freshly-created (unstaged) file still shows while `node_modules` etc. stay
 * hidden — and it needs no commit or git identity to run. When the cwd isn't a
 * repo (or git is absent) we fall back to a bounded directory walk that skips
 * the usual noise dirs, so mentions still work outside git.
 *
 * The parsing/ranking is pure and lives in mentions.logic.ts; this module is
 * only the IO shell.
 */

import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"

import { parseFileList } from "./mentions.logic.js"

const execFileAsync = promisify(execFile)

/** Dirs never worth walking for a mention list — huge, and virtually never
 *  what an operator wants to hand the agent by name. Only consulted on the
 *  non-git fallback; inside a repo `.gitignore` already excludes most of these. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".next", ".turbo", "coverage", ".venv"])
/** A safety ceiling so the fallback walk can't wander an enormous tree. */
const WALK_CAP = 4000

export async function listRepoFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    const files = parseFileList(stdout)
    if (files.length > 0) return files
  } catch {
    // Not a git repo, git not installed, or the spawn failed — fall back.
  }
  return walkFiles(cwd)
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && out.length < WALK_CAP) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (!entries) continue
    for (const entry of entries) {
      if (out.length >= WALK_CAP) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full)
      } else if (entry.isFile()) {
        out.push(relative(root, full))
      }
    }
  }
  return out
}
