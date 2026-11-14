import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { runWorktree } from "../commands/worktree.js"

const cleanupPaths: string[] = []
const realHome = process.env["HOME"]

afterEach(async () => {
  process.env["HOME"] = realHome
  delete process.env["AGENTPROTO_WORKTREES_ROOT"]
  vi.restoreAllMocks()
  for (const p of cleanupPaths.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
  return res.stdout
}

function hasBranch(repo: string, branch: string): boolean {
  return spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0
}

async function tmp(prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)))
  cleanupPaths.push(dir)
  return dir
}

async function setup(): Promise<{ repo: string; home: string }> {
  const repo = await tmp("wt-arch-repo-")
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@t.t")
  git(repo, "config", "user.name", "t")
  await writeFile(join(repo, "f"), "x")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")
  process.env["AGENTPROTO_WORKTREES_ROOT"] = await tmp("wt-arch-root-")
  // The salvage root is `~/.agentproto/worktree-salvage`: keep it out of the real home.
  const home = await tmp("wt-arch-home-")
  process.env["HOME"] = home
  return { repo, home }
}

async function newWorktree(repo: string, slug: string, opts: { commit?: boolean } = {}): Promise<string> {
  expect(await runWorktree(["new", slug, "--repo", repo, "--base", "main", "--no-setup"])).toBe(0)
  const wt = join(process.env["AGENTPROTO_WORKTREES_ROOT"]!, basename(repo), slug)
  if (opts.commit) {
    await writeFile(join(wt, "unmerged.ts"), "export {}\n")
    git(wt, "add", ".")
    git(wt, "commit", "-q", "-m", "local-only work")
  }
  return wt
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    chunks.push(String(c))
    return true
  })
  return { text: () => chunks.join("") }
}

async function readManifest(home: string): Promise<{ branchDecision?: { action: string; reason: string; commitsNotOnAnyRemote: number | null } }> {
  const root = join(home, ".agentproto", "worktree-salvage")
  const [repoDir] = await readdir(root)
  const [dir] = await readdir(join(root, repoDir!))
  return JSON.parse(await readFile(join(root, repoDir!, dir!, "MANIFEST.json"), "utf8"))
}

describe("worktree archive / rm: the branch is only deleted when proven merged", () => {
  it("archive of an unmerged local-only branch keeps the branch and records the decision", { timeout: 30_000 }, async () => {
    const { repo, home } = await setup()
    const wt = await newWorktree(repo, "unmerged", { commit: true })
    const out = captureStdout()

    expect(await runWorktree(["archive", wt, "--repo", repo])).toBe(0)

    expect(existsSync(wt)).toBe(false)
    expect(hasBranch(repo, "wt/unmerged")).toBe(true)
    expect(out.text()).toContain("branch wt/unmerged kept")
    expect(out.text()).toContain("commit(s) exist on no remote")
    const manifest = await readManifest(home)
    expect(manifest.branchDecision?.action).toBe("kept")
    expect(manifest.branchDecision?.commitsNotOnAnyRemote).toBeGreaterThan(0)
  })

  it("archive of a branch already merged into base still deletes it", { timeout: 30_000 }, async () => {
    const { repo, home } = await setup()
    const wt = await newWorktree(repo, "merged")
    expect(await runWorktree(["archive", wt, "--repo", repo])).toBe(0)
    expect(hasBranch(repo, "wt/merged")).toBe(false)
    expect((await readManifest(home)).branchDecision).toMatchObject({ action: "deleted" })
  })

  it("archive --force deletes an unmerged branch anyway and says why", { timeout: 30_000 }, async () => {
    const { repo, home } = await setup()
    const wt = await newWorktree(repo, "forced", { commit: true })
    expect(await runWorktree(["archive", wt, "--repo", repo, "--force"])).toBe(0)
    expect(hasBranch(repo, "wt/forced")).toBe(false)
    expect((await readManifest(home)).branchDecision?.reason).toContain("--force")
  })

  it("archive --keep-branch keeps even a merged branch", { timeout: 30_000 }, async () => {
    const { repo, home } = await setup()
    const wt = await newWorktree(repo, "keepme")
    expect(await runWorktree(["archive", wt, "--repo", repo, "--keep-branch"])).toBe(0)
    expect(hasBranch(repo, "wt/keepme")).toBe(true)
    expect((await readManifest(home)).branchDecision).toMatchObject({ action: "kept", reason: "--keep-branch" })
  })

  it("rm of an unmerged branch keeps it; --force deletes it", { timeout: 30_000 }, async () => {
    const { repo } = await setup()
    const a = await newWorktree(repo, "rm-keep", { commit: true })
    const out = captureStdout()
    expect(await runWorktree(["rm", a, "--repo", repo])).toBe(0)
    expect(existsSync(a)).toBe(false)
    expect(hasBranch(repo, "wt/rm-keep")).toBe(true)
    expect(out.text()).toContain("branch wt/rm-keep kept")

    const b = await newWorktree(repo, "rm-force", { commit: true })
    expect(await runWorktree(["rm", b, "--repo", repo, "--force"])).toBe(0)
    expect(hasBranch(repo, "wt/rm-force")).toBe(false)
  })
})
