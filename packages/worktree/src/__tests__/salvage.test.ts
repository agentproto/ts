import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import { salvageWorktree } from "../salvage.js"
import { cleanupWorktreeTool } from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { execGit } from "../exec.js"

const candidates = [worktreeProvider]

async function makeTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "wt-salvage-repo-"))
  await execGit(repoRoot, ["init", "-b", "main"])
  await execGit(repoRoot, ["config", "user.email", "test@example.com"])
  await execGit(repoRoot, ["config", "user.name", "Test"])
  await writeFile(join(repoRoot, "README.md"), "hello\n")
  await execGit(repoRoot, ["add", "."])
  await execGit(repoRoot, ["commit", "-m", "init"])
  return repoRoot
}

describe("salvageWorktree", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("captures a changes.patch for modified tracked files and copies untracked files, with a matching manifest", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-salvage-out-"))
    cleanupPaths.push(salvageRoot)

    const wtDir = join(repoRoot, "_worktrees", "dirty-one")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/dirty-one"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "README.md"), "edited\n")
    await mkdir(join(wtDir, "nested"), { recursive: true })
    await writeFile(join(wtDir, "nested", "scratch.txt"), "stray output\n")

    const headRes = await execGit(wtDir, ["rev-parse", "HEAD"])
    const tipSha = headRes.stdout.trim()

    const { dir, manifest } = await salvageWorktree({
      repoRoot,
      repoName: "test-repo",
      worktreePath: wtDir,
      branch: "wt/dirty-one",
      tipSha,
      slug: "dirty-one",
      salvageRoot,
      now: () => "2026-07-15T00:00:00.000Z",
    })

    expect(dir).toContain(salvageRoot)
    expect(dir).toContain("dirty-one")
    expect(dir).toContain(tipSha.slice(0, 7))

    const patch = await readFile(join(dir, "changes.patch"), "utf8")
    expect(patch).toContain("README.md")
    expect(patch).toContain("edited")

    const copied = await readFile(join(dir, "untracked", "nested", "scratch.txt"), "utf8")
    expect(copied).toBe("stray output\n")

    const manifestOnDisk = JSON.parse(await readFile(join(dir, "MANIFEST.json"), "utf8"))
    expect(manifestOnDisk).toEqual(manifest)
    expect(manifest.repo).toBe("test-repo")
    expect(manifest.branch).toBe("wt/dirty-one")
    expect(manifest.tipSha).toBe(tipSha)
    expect(manifest.hasPatch).toBe(true)
    expect(manifest.untrackedFiles).toEqual(["nested/scratch.txt"])
  })

  it("archive semantics: salvage then remove — the salvaged bytes survive the worktree's deletion", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-salvage-out-"))
    cleanupPaths.push(salvageRoot)

    const wtDir = join(repoRoot, "_worktrees", "to-archive")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/to-archive"])
    await writeFile(join(wtDir, "README.md"), "important edit\n")
    await writeFile(join(wtDir, "untracked-scratch.txt"), "agent scratch output\n")

    const headRes = await execGit(wtDir, ["rev-parse", "HEAD"])
    const tipSha = headRes.stdout.trim()

    // 1. Salvage BEFORE removal — this is what makes `archive` safe.
    const { dir } = await salvageWorktree({
      repoRoot,
      repoName: "test-repo",
      worktreePath: wtDir,
      branch: "wt/to-archive",
      tipSha,
      slug: "to-archive",
      salvageRoot,
    })

    // 2. Only now does the destructive removal happen, with both flags
    // granted (mirroring the CLI's `archive` verb).
    const result = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: wtDir, discardUntracked: true, discardModified: true, deleteBranch: true, branch: "wt/to-archive" },
    })
    expect(result).toEqual({ removed: true })

    // The worktree is gone...
    await expect(readFile(join(wtDir, "README.md"), "utf8")).rejects.toThrow()

    // ...but the salvaged copies are still there, untouched by the removal.
    const salvagedPatch = await readFile(join(dir, "changes.patch"), "utf8")
    expect(salvagedPatch).toContain("important edit")
    const salvagedUntracked = await readFile(join(dir, "untracked", "untracked-scratch.txt"), "utf8")
    expect(salvagedUntracked).toBe("agent scratch output\n")
  })

  it("is safe to call on a clean tree: empty patch, no untracked files, still writes a manifest", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-salvage-out-"))
    cleanupPaths.push(salvageRoot)

    const wtDir = join(repoRoot, "_worktrees", "clean")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/clean"])
    cleanupPaths.push(wtDir)

    const headRes = await execGit(wtDir, ["rev-parse", "HEAD"])
    const { manifest } = await salvageWorktree({
      repoRoot,
      repoName: "test-repo",
      worktreePath: wtDir,
      branch: "wt/clean",
      tipSha: headRes.stdout.trim(),
      slug: "clean",
      salvageRoot,
    })

    expect(manifest.hasPatch).toBe(false)
    expect(manifest.untrackedFiles).toEqual([])
  })
})
