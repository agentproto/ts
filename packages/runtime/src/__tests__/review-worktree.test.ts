/**
 * `branch_gc_review_worktree`'s kernel against a real disposable git repo:
 * reviewers get a detached worktree outside the repo, removal is confined to
 * the review root, and a verdict tool handed the worktree path resolves the
 * owning repo.
 */
import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addReviewWorktree,
  ownerRepoOfReviewWorktree,
  removeReviewWorktrees,
  reviewWorktreeRoot,
} from "../review-worktree.js"

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

function makeRepo(): { repo: string; sha: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "review-wt-repo-")))
  cleanup.push(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@e.com")
  git(repo, "config", "user.name", "T")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "a.txt")
  git(repo, "commit", "-q", "-m", "init")
  // Uncommitted WIP in the live checkout — must survive everything below.
  writeFileSync(join(repo, "wip.txt"), "human work in progress\n")
  return { repo, sha: git(repo, "rev-parse", "HEAD") }
}

const worktreesOf = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => realpathSync(l.slice(9)))

describe("review worktrees", () => {
  it("add → detached worktree outside the repo; a checkout there leaves the live checkout alone; remove + prune clears it", async () => {
    const { repo, sha } = makeRepo()
    const path = join(reviewWorktreeRoot(), `test-${process.pid}-${sha}`)
    cleanup.push(path)
    const added = await addReviewWorktree({ repoRoot: repo, path, sha })
    expect(existsSync(join(added.path, "a.txt"))).toBe(true)
    expect(added.path.startsWith(realpathSync(repo))).toBe(false)
    expect(git(added.path, "rev-parse", "HEAD")).toBe(sha)
    expect(git(added.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD") // detached

    // What a misbehaving reviewer did — now in its own worktree.
    git(added.path, "checkout", "-q", "-b", "reviewer-was-here")
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(existsSync(join(repo, "wip.txt"))).toBe(true)

    // The verdict tools map the worktree back to its repo.
    expect(await ownerRepoOfReviewWorktree(added.path)).toBe(realpathSync(repo))
    expect(await ownerRepoOfReviewWorktree(repo)).toBe(repo)

    const { removed } = await removeReviewWorktrees({ repoRoot: repo, paths: [path, join(reviewWorktreeRoot(), "never-created")] })
    expect(removed).toEqual([added.path])
    expect(existsSync(added.path)).toBe(false)
    expect(worktreesOf(repo)).toEqual([realpathSync(repo)])
    expect(existsSync(join(repo, "wip.txt"))).toBe(true)
  })

  it("add replaces a stale worktree left by a crashed run", async () => {
    const { repo, sha } = makeRepo()
    const path = join(reviewWorktreeRoot(), `test-stale-${process.pid}-${sha}`)
    cleanup.push(path)
    await addReviewWorktree({ repoRoot: repo, path, sha })
    writeFileSync(join(path, "junk.txt"), "left behind\n")
    await addReviewWorktree({ repoRoot: repo, path, sha })
    expect(existsSync(join(path, "junk.txt"))).toBe(false)
    await removeReviewWorktrees({ repoRoot: repo, paths: [path] })
  })

  it("refuses any path outside the review root — it can never remove the repo or a human's worktree", async () => {
    const { repo, sha } = makeRepo()
    await expect(addReviewWorktree({ repoRoot: repo, path: join(repo, "..", "elsewhere"), sha })).rejects.toThrow(/direct child/)
    await expect(removeReviewWorktrees({ repoRoot: repo, paths: [repo] })).rejects.toThrow(/direct child/)
    await expect(
      removeReviewWorktrees({ repoRoot: repo, paths: [join(reviewWorktreeRoot(), "..", "x")] }),
    ).rejects.toThrow(/direct child/)
    expect(existsSync(join(repo, "wip.txt"))).toBe(true)
  })
})
