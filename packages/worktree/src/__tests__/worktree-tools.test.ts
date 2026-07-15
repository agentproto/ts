import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { runTool } from "@agentproto/driver"
import { provisionWorktreeTool, cleanupWorktreeTool, runGateTool } from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { execGit, execArgv } from "../exec.js"
import { WorktreeNotRemovableError } from "../provider/bodies/cleanup-worktree.body.js"
import { readWorktreeMarker } from "../provenance.js"

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

  it("honours explicit `branch` and `dir` inputs instead of the wt/<slug> / _worktrees default (v0.2.0)", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const customDir = join(await mkdtemp(join(tmpdir(), "wt-custom-dir-")), "somewhere-else")
    cleanupPaths.push(dirname(customDir))

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: { repoRoot, base: "main", slug: "test-feature", branch: "feat/custom", dir: customDir },
    })
    expect(provisioned.branch).toBe("feat/custom")
    expect(provisioned.cwd).toBe(customDir)

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd, branch: provisioned.branch, deleteBranch: true },
    })
  })

  it("writes the PR-B creation-provenance marker into the worktree's private gitdir", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)

    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: { repoRoot, base: "main", slug: "with-marker" },
    })
    cleanupPaths.push(provisioned.cwd)

    const marker = await readWorktreeMarker(provisioned.cwd)
    expect(marker).not.toBeNull()
    expect(marker?.worktreeId).toMatch(/^wt_/)
    expect(marker?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(marker?.createdBySessionId).toBeUndefined()

    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd },
    })
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

    // depsCmd's output is an untracked file — authorize discarding it.
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd, discardUntracked: true },
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

    // The symlink + depsCmd's output are untracked — authorize discarding them.
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd, discardUntracked: true },
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

    // The test's own .gitignore is never committed to "main", so the new
    // worktree's checkout doesn't have it — the copied secret shows up
    // genuinely untracked here (a repo that commits its .gitignore, the
    // common case, wouldn't need this flag for this file).
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: provisioned.cwd, discardUntracked: true },
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

describe("worktree.cleanup — discard-flag guard (the safety flip)", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("refuses by default when the worktree has an untracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "untracked-dirty")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/untracked-dirty"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "scratch.txt"), "stray output\n")

    await expect(
      runTool({ tool: cleanupWorktreeTool, candidates, input: { repoRoot, cwd: wtDir } }),
    ).rejects.toThrow()

    // Refused, not removed: the worktree is still on disk and still known to git.
    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).toContain(wtDir)
  })

  it("refuses by default when the worktree has a modified tracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "modified-dirty")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/modified-dirty"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "README.md"), "edited\n")

    let thrown: unknown
    try {
      await runTool({ tool: cleanupWorktreeTool, candidates, input: { repoRoot, cwd: wtDir } })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WorktreeNotRemovableError)

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).toContain(wtDir)
  })

  it("discardUntracked alone still refuses a modified tracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "both-dirty")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/both-dirty"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "README.md"), "edited\n")
    await writeFile(join(wtDir, "scratch.txt"), "stray output\n")

    let thrown: unknown
    try {
      await runTool({
        tool: cleanupWorktreeTool,
        candidates,
        input: { repoRoot, cwd: wtDir, discardUntracked: true },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WorktreeNotRemovableError)
    expect((thrown as InstanceType<typeof WorktreeNotRemovableError>).blocked).toEqual(["modified"])

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).toContain(wtDir)
  })

  it("discardUntracked alone removes a worktree with only an untracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "untracked-only")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/untracked-only"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "scratch.txt"), "stray output\n")

    const result = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: wtDir, discardUntracked: true },
    })
    expect(result).toEqual({ removed: true })

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).not.toContain(wtDir)
  })

  it("discardModified alone still refuses an untracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "untracked-blocks-modified")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/untracked-blocks-modified"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "scratch.txt"), "stray output\n")

    let thrown: unknown
    try {
      await runTool({
        tool: cleanupWorktreeTool,
        candidates,
        input: { repoRoot, cwd: wtDir, discardModified: true },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WorktreeNotRemovableError)
    expect((thrown as InstanceType<typeof WorktreeNotRemovableError>).blocked).toEqual(["untracked"])

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).toContain(wtDir)
  })

  it("discardModified alone removes a worktree with only a modified tracked file", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "modified-only")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/modified-only"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "README.md"), "edited\n")

    const result = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: wtDir, discardModified: true },
    })
    expect(result).toEqual({ removed: true })

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).not.toContain(wtDir)
  })

  it("both flags together remove a worktree dirty with both classes", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "both-flags")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/both-flags"])
    cleanupPaths.push(wtDir)
    await writeFile(join(wtDir, "README.md"), "edited\n")
    await writeFile(join(wtDir, "scratch.txt"), "stray output\n")

    const result = await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: { repoRoot, cwd: wtDir, discardUntracked: true, discardModified: true },
    })
    expect(result).toEqual({ removed: true })

    const wtList = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
    expect(wtList.stdout).not.toContain(wtDir)
  })

  it("a clean tree removes with no flags at all (unaffected by the guard)", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const wtDir = join(repoRoot, "_worktrees", "clean")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/clean"])
    cleanupPaths.push(wtDir)

    const result = await runTool({ tool: cleanupWorktreeTool, candidates, input: { repoRoot, cwd: wtDir } })
    expect(result).toEqual({ removed: true })
  })

  it("gitignored files never block removal, with or without flags", async () => {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    await writeFile(join(repoRoot, ".gitignore"), "node_modules\n")
    await execGit(repoRoot, ["add", ".gitignore"])
    await execGit(repoRoot, ["commit", "-m", "gitignore"])
    const wtDir = join(repoRoot, "_worktrees", "gitignored-only")
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", "wt/gitignored-only"])
    cleanupPaths.push(wtDir)
    await mkdir(join(wtDir, "node_modules"), { recursive: true })
    await writeFile(join(wtDir, "node_modules", "dep.js"), "module.exports = 1\n")

    const result = await runTool({ tool: cleanupWorktreeTool, candidates, input: { repoRoot, cwd: wtDir } })
    expect(result).toEqual({ removed: true })
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
