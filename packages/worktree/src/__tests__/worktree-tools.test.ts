import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import { provisionWorktreeTool, cleanupWorktreeTool, runGateTool } from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { execGit, execArgv } from "../exec.js"

const candidates = [worktreeProvider]

/** A disposable git repo with one commit on `main`, for real (non-mocked) git-worktree ops. */
async function makeTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "wt-tool-repo-"))
  await execGit(repoRoot, ["init", "-b", "main"])
  await execGit(repoRoot, ["config", "user.email", "test@example.com"])
  await execGit(repoRoot, ["config", "user.name", "Test"])
  await writeFile(join(repoRoot, "README.md"), "hello\n")
  await execGit(repoRoot, ["add", "."])
  await execGit(repoRoot, ["commit", "-m", "init"])
  return repoRoot
}

describe("worktree.provision + worktree.cleanup (real git, disposable repo)", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("creates a real worktree on a new branch, then removes it", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: { repoRoot, base: "main", slug: "test-feature" },
    })
    cleanupPaths.push(provisioned.cwd)
    expect(provisioned.branch).toBe("wt/test-feature")
    expect(provisioned.cwd).toContain("_worktrees/test-feature")
    const marker = await readFile(join(provisioned.cwd, "README.md"), "utf8")
    expect(marker).toBe("hello\n")

    const cleaned = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd, branch: provisioned.branch, deleteBranch: true },
    })
    expect(cleaned).toEqual({ removed: true })

    const branches = await execGit(repoRoot, ["branch", "--list", "wt/test-feature"])
    expect(branches.stdout.trim()).toBe("")
  })

  it("runs depsCmd inside the new worktree", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: {
        repoRoot,
        base: "main",
        slug: "with-deps",
        depsCmd: "node -e \"require('fs').writeFileSync('deps-ran.txt','ok')\"",
      },
    })
    cleanupPaths.push(provisioned.cwd)
    const marker = await readFile(join(provisioned.cwd, "deps-ran.txt"), "utf8")
    expect(marker).toBe("ok")

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd },
    })
  })

  it("symlinks linkPaths from the host repo into the worktree, before depsCmd", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    // A gitignored, host-only dir a fresh worktree wouldn't carry.
    await mkdir(join(repoRoot, "node_modules", "dep"), { recursive: true })
    await writeFile(join(repoRoot, "node_modules", "dep", "index.js"), "module.exports = 1\n")
    await writeFile(join(repoRoot, ".gitignore"), "node_modules\n")

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: {
        repoRoot,
        base: "main",
        slug: "with-links",
        linkPaths: ["node_modules"],
        // Proves the link exists BEFORE depsCmd: reads through the symlink.
        depsCmd:
          "node -e \"require('fs').writeFileSync('linked.txt', require('fs').readFileSync('node_modules/dep/index.js','utf8'))\"",
      },
    })
    cleanupPaths.push(provisioned.cwd)

    const linkStat = await lstat(join(provisioned.cwd, "node_modules"))
    expect(linkStat.isSymbolicLink()).toBe(true)
    const seenByDeps = await readFile(join(provisioned.cwd, "linked.txt"), "utf8")
    expect(seenByDeps).toBe("module.exports = 1\n")

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd },
    })
  })

  it("leaves an already-present path untouched instead of clobbering it", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    // README.md is tracked, so the fresh worktree already has it — a link for
    // it must be a no-op (keep the checked-out file, not a symlink to host).
    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: { repoRoot, base: "main", slug: "no-clobber", linkPaths: ["README.md"] },
    })
    cleanupPaths.push(provisioned.cwd)

    const stat = await lstat(join(provisioned.cwd, "README.md"))
    expect(stat.isSymbolicLink()).toBe(false)
    const content = await readFile(join(provisioned.cwd, "README.md"), "utf8")
    expect(content).toBe("hello\n")

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd },
    })
  })

  it("copies gitignored secrets matching copyGlobs into the worktree", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    await mkdir(join(repoRoot, "envs", "prod"), { recursive: true })
    await writeFile(join(repoRoot, "envs", "prod", ".env.local"), "SECRET=1\n")
    await writeFile(join(repoRoot, ".gitignore"), "envs/**/.env.local\n")

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: {
        repoRoot,
        base: "main",
        slug: "with-secrets",
        copyGlobs: ["envs/**/.env.local"],
      },
    })
    cleanupPaths.push(provisioned.cwd)
    const copied = await readFile(join(provisioned.cwd, "envs", "prod", ".env.local"), "utf8")
    expect(copied).toBe("SECRET=1\n")

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd },
    })
  })

  it("archives a real linked git worktree — dir removed, branch deleted, worktree list clean", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    const wtDir = join(repoRoot, "_worktrees", "archive-test")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/archive-test"])

    const resolved = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: wtDir, branch: "wt/archive-test", deleteBranch: true },
    })
    expect(resolved).toEqual({ removed: true })

    // Worktree directory is gone.
    await expect(rm(wtDir)).rejects.toThrow()

    // Branch was deleted.
    const branches = await execGit(repoRoot, ["branch", "--list", "wt/archive-test"])
    expect(branches.stdout.trim()).toBe("")

    // git worktree list no longer knows about it.
    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).not.toContain("archive-test")
  })
})

describe("worktree.run-gate", () => {
  it("reports pass on exit 0", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "wt-gate-"))
    try {
      const result = await runTool({
        tool: runGateTool,
        candidates,
        input: { cwd: repoRoot, cmd: "exit 0" },
      })
      expect(result.passed).toBe(true)
      expect(result.exitCode).toBe(0)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("reports fail on non-zero exit, capturing stderr", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "wt-gate-"))
    try {
      const result = await runTool({
        tool: runGateTool,
        candidates,
        input: { cwd: repoRoot, cmd: "echo boom 1>&2; exit 1" },
      })
      expect(result.passed).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("boom")
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
