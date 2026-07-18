import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { runWorktree } from "../commands/worktree.js"

const cleanupPaths: string[] = []
let restoreCwd: string | null = null

afterEach(async () => {
  if (restoreCwd) {
    process.chdir(restoreCwd)
    restoreCwd = null
  }
  delete process.env["AGENTPROTO_WORKTREES_ROOT"]
  for (const p of cleanupPaths.splice(0)) {
    await rm(p, { recursive: true, force: true }).catch(() => {})
  }
})

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepo(): Promise<string> {
  // realpath so macOS /var → /private/var symlinking doesn't defeat equality.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "wt-rm-repo-")))
  cleanupPaths.push(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  await writeFile(join(root, "f"), "x")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

/** A fresh worktrees.root, wired via env so `new` AND `rm`'s slug fallback
 * (which reads `resolveWorktreesRoot(undefined)`) agree on the same root. */
async function makeWorktreesRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "wt-rm-root-")))
  cleanupPaths.push(root)
  process.env["AGENTPROTO_WORKTREES_ROOT"] = root
  return root
}

/** A directory that is NOT inside any git repo — the reproducing cwd. */
async function makeUnrelatedCwd(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "wt-rm-elsewhere-")))
  cleanupPaths.push(dir)
  restoreCwd = process.cwd()
  process.chdir(dir)
  return dir
}

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

async function newWorktree(repoRoot: string, slug: string): Promise<string> {
  const code = await runWorktree(["new", slug, "--repo", repoRoot, "--base", "main"])
  expect(code).toBe(0)
  return join(process.env["AGENTPROTO_WORKTREES_ROOT"]!, basename(repoRoot), slug)
}

describe("agentproto worktree rm — resolve a slug from a cwd outside the repo (repro: PR #460 follow-up)", () => {
  it("removes a worktree given its bare <slug> from an unrelated cwd", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    await makeWorktreesRoot()
    const wtDir = await newWorktree(repoRoot, "model-catalog-3axis")
    expect(existsSync(wtDir)).toBe(true)

    // The reproducing conditions: a cwd that is NOT inside the target repo.
    await makeUnrelatedCwd()

    const code = await runWorktree(["rm", "model-catalog-3axis"])
    expect(code).toBe(0)
    expect(existsSync(wtDir)).toBe(false)
    // branch deleted too
    const branches = spawnSync("git", ["-C", repoRoot, "branch", "--list", "wt/model-catalog-3axis"], {
      encoding: "utf8",
    })
    expect(branches.stdout.trim()).toBe("")
  })

  it("accepts the wt/<slug> branch spelling that `ls` displays", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    await makeWorktreesRoot()
    const wtDir = await newWorktree(repoRoot, "model-catalog-3axis")
    await makeUnrelatedCwd()

    const code = await runWorktree(["rm", "wt/model-catalog-3axis"])
    expect(code).toBe(0)
    expect(existsSync(wtDir)).toBe(false)
  })

  it("still removes a worktree given its explicit path from an unrelated cwd", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    await makeWorktreesRoot()
    const wtDir = await newWorktree(repoRoot, "by-path")
    await makeUnrelatedCwd()

    const code = await runWorktree(["rm", wtDir])
    expect(code).toBe(0)
    expect(existsSync(wtDir)).toBe(false)
  })

  it("errors with where it looked when the slug is not a known worktree", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    const root = await makeWorktreesRoot()
    // A real worktree exists (so the repo's bucket is present to scan), but not
    // the slug we ask to remove.
    await newWorktree(repoRoot, "real-one")
    await makeUnrelatedCwd()

    const err = captureStderr()
    let code: number
    try {
      code = await runWorktree(["rm", "no-such-slug"])
    } finally {
      err.restore()
    }
    expect(code).toBe(2)
    const text = err.chunks.join("")
    expect(text).toContain('could not resolve the git repo for "no-such-slug"')
    // Names both the path it tried and the worktrees.root it scanned.
    expect(text).toContain(join(process.cwd(), "no-such-slug"))
    expect(text).toContain(root)
  })
})
