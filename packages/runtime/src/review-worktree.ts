/**
 * Disposable review worktrees for the `maintain` workflow's reviewer agents
 * (`branch_gc_review_worktree`).
 *
 * A reviewer used to run in the user's LIVE checkout, and one ran
 * `git stash && git checkout <old branch>` there — stashing a human's WIP and
 * deleting the directory every later reviewer was spawned in. Each review now
 * gets its own detached worktree of the tip under review, outside the repo, so
 * a checkout/stash/reset there changes nothing anyone else uses.
 *
 * Every path this module touches must sit directly under
 * {@link reviewWorktreeRoot} — `remove` can never be pointed at the repo's
 * main worktree or at a human's linked worktree.
 */

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** `<os tmpdir>/agentproto-maintain-review` — the only place review
 *  worktrees may live. The maintain workflow's `entry.mjs` names each one
 *  `<this>/<repoName>-<tip sha>` (same process, same tmpdir). */
export function reviewWorktreeRoot(): string {
  return join(tmpdir(), "agentproto-maintain-review")
}

function git(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0
      done({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Canonical form for comparing paths (macOS tmpdir is behind a symlink). */
function canonical(p: string): string {
  const abs = resolve(p)
  if (existsSync(abs)) return realpathSync(abs)
  const parent = dirname(abs)
  return existsSync(parent) ? join(realpathSync(parent), basename(abs)) : abs
}

/** Throws unless `path` is a direct child of {@link reviewWorktreeRoot}. */
export function assertReviewWorktreePath(path: string): string {
  // Exists from here on, so both sides canonicalize through the same symlinks.
  mkdirSync(reviewWorktreeRoot(), { recursive: true })
  const root = canonical(reviewWorktreeRoot())
  const p = canonical(path)
  if (dirname(p) !== root || basename(p).startsWith(".")) {
    throw new Error(`review worktree path must be a direct child of ${root} (got ${path})`)
  }
  return p
}

/** True when `path` is a (would-be) review worktree path. */
export function isReviewWorktreePath(path: string): boolean {
  try {
    assertReviewWorktreePath(path)
    return true
  } catch {
    return false
  }
}

/** Absolute paths of every worktree `git worktree list` reports for `repoRoot`. */
async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  const res = await git(repoRoot, ["worktree", "list", "--porcelain"])
  if (res.code !== 0) throw new Error(`git worktree list failed: ${res.stderr.trim()}`)
  return res.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => canonical(l.slice("worktree ".length)))
}

/**
 * Create a detached worktree of `sha` at `path` (a stale one left by a
 * crashed run is replaced). Hooks are off — a repo's post-checkout hook has no
 * business running for a throwaway review tree.
 */
export async function addReviewWorktree(input: { repoRoot: string; path: string; sha: string }): Promise<{ path: string; sha: string }> {
  const path = assertReviewWorktreePath(input.path)
  if (!/^[0-9a-f]{7,64}$/i.test(input.sha)) throw new Error(`not a commit sha: ${input.sha}`)
  const repoRoot = canonical(input.repoRoot)
  if ((await listWorktreePaths(repoRoot)).includes(path) || existsSync(path)) {
    await removeReviewWorktrees({ repoRoot, paths: [path] })
  }
  const res = await git(repoRoot, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", path, input.sha])
  if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim() || res.stdout.trim()}`)
  return { path, sha: input.sha }
}

/**
 * Remove review worktrees (`git worktree remove --force`, then delete any
 * leftover directory) and `git worktree prune`. A path that is already gone
 * is fine — this runs from a workflow's `finally`, over every candidate.
 */
export async function removeReviewWorktrees(input: { repoRoot: string; paths: readonly string[] }): Promise<{ removed: string[] }> {
  const paths = input.paths.map(assertReviewWorktreePath)
  const repoRoot = canonical(input.repoRoot)
  const registered = new Set(await listWorktreePaths(repoRoot))
  const removed: string[] = []
  for (const path of paths) {
    if (path === repoRoot) throw new Error(`refusing to remove the repo's own worktree: ${path}`)
    const wasThere = registered.has(path) || existsSync(path)
    if (registered.has(path)) await git(repoRoot, ["worktree", "remove", "--force", "--force", path])
    await rm(path, { recursive: true, force: true })
    if (wasThere) removed.push(path)
  }
  await git(repoRoot, ["worktree", "prune"])
  return { removed }
}

/**
 * A review worktree path handed to a verdict tool → the repo it belongs to
 * (its main worktree), so a reviewer never needs the live repo's path: the
 * verdict store keys on the repo, and `repoLabel` is the path's basename.
 * Any other path is returned unchanged.
 */
export async function ownerRepoOfReviewWorktree(path: string): Promise<string> {
  if (!isReviewWorktreePath(path) || !existsSync(path)) return path
  const res = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const common = res.stdout.trim()
  if (res.code !== 0 || basename(common) !== ".git") return path
  return dirname(common)
}
