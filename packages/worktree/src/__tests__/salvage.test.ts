import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, readlink, lstat, chmod, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import { salvageWorktree, restoreSalvage } from "../salvage.js"
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

  async function dirtyWorktree(name: string) {
    const repoRoot = await makeTempRepo()
    cleanupPaths.push(repoRoot)
    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-salvage-out-"))
    cleanupPaths.push(salvageRoot)
    const wtDir = join(repoRoot, "_worktrees", name)
    await execGit(repoRoot, ["worktree", "add", wtDir, "-b", `wt/${name}`])
    cleanupPaths.push(wtDir)
    const tipSha = (await execGit(wtDir, ["rev-parse", "HEAD"])).stdout.trim()
    const run = () =>
      salvageWorktree({ repoRoot, repoName: "test-repo", worktreePath: wtDir, branch: `wt/${name}`, tipSha, slug: name, salvageRoot, now: () => "2026-07-15T00:00:00.000Z" })
    return { repoRoot, salvageRoot, wtDir, run }
  }

  it("archives an untracked nested git repo recursively (never skipped, then deleted)", async () => {
    const { wtDir, run } = await dirtyWorktree("nested")
    const nested = join(wtDir, "nested")
    await mkdir(nested, { recursive: true })
    await execGit(nested, ["init", "-b", "main"])
    await execGit(nested, ["config", "user.email", "t@example.com"])
    await execGit(nested, ["config", "user.name", "T"])
    await writeFile(join(nested, "f.txt"), "nested bytes\n")
    await execGit(nested, ["add", "."])
    await execGit(nested, ["commit", "-m", "n"])

    const { dir, manifest } = await run()
    expect(manifest.skippedEntries).toBeUndefined()
    expect(manifest.untrackedFiles).toContain("nested/f.txt")
    expect(await readFile(join(dir, "untracked", "nested", "f.txt"), "utf8")).toBe("nested bytes\n")
    expect(manifest.untrackedFiles.some((f) => f.startsWith("nested/.git/"))).toBe(true)
  })

  it("archives files whose names git would C-quote (non-ASCII, tab, quote)", async () => {
    const { wtDir, run } = await dirtyWorktree("quoted")
    const names = ["café.txt", "tab\tname.txt", 'quote"name.txt']
    for (const n of names) await writeFile(join(wtDir, n), `content of ${n}\n`)

    const { dir, manifest } = await run()
    expect([...manifest.untrackedFiles].sort()).toEqual([...names].sort())
    for (const n of names) expect(await readFile(join(dir, "untracked", n), "utf8")).toBe(`content of ${n}\n`)
  })

  it("keeps an untracked symlink to a directory as a link, lists it, and restore recreates it", async () => {
    const { wtDir, run } = await dirtyWorktree("sym-dir")
    await mkdir(join(wtDir, "real-dir"), { recursive: true })
    await writeFile(join(wtDir, "real-dir", "a.txt"), "a\n")
    await mkdir(join(wtDir, "projects"), { recursive: true })
    await symlink("../real-dir", join(wtDir, "projects", "pieces"))

    const { dir, manifest } = await run()
    expect(manifest.symlinks).toEqual([{ path: "projects/pieces", target: "../real-dir" }])
    expect(manifest.untrackedFiles).not.toContain("projects/pieces")
    const archived = join(dir, "untracked", "projects", "pieces")
    expect((await lstat(archived)).isSymbolicLink()).toBe(true)
    expect(await readlink(archived)).toBe("../real-dir")

    const fresh = await mkdtemp(join(tmpdir(), "wt-salvage-restore-"))
    cleanupPaths.push(fresh)
    const res = await restoreSalvage(dir, fresh)
    expect(res.symlinks).toBe(1)
    expect(await readlink(join(fresh, "projects", "pieces"))).toBe("../real-dir")
    expect(await readFile(join(fresh, "real-dir", "a.txt"), "utf8")).toBe("a\n")
  })

  it("keeps a dangling untracked symlink without error", async () => {
    const { wtDir, run } = await dirtyWorktree("sym-dangling")
    await symlink("does/not/exist", join(wtDir, "ghost"))
    const { dir, manifest } = await run()
    expect(manifest.symlinks).toEqual([{ path: "ghost", target: "does/not/exist" }])
    expect(await readlink(join(dir, "untracked", "ghost"))).toBe("does/not/exist")
    const fresh = await mkdtemp(join(tmpdir(), "wt-salvage-restore-"))
    cleanupPaths.push(fresh)
    await restoreSalvage(dir, fresh)
    expect(await readlink(join(fresh, "ghost"))).toBe("does/not/exist")
  })

  it.skipIf(process.getuid?.() === 0)("removes the half-written archive when the salvage fails, leaving the worktree intact", async () => {
    const { wtDir, salvageRoot, run } = await dirtyWorktree("fails")
    await writeFile(join(wtDir, "a-ok.txt"), "ok\n")
    const locked = join(wtDir, "b-locked.txt")
    await writeFile(locked, "secret\n")
    await chmod(locked, 0o000)
    try {
      await expect(run()).rejects.toThrow()
    } finally {
      await chmod(locked, 0o644)
    }
    await expect(readdir(join(salvageRoot, "test-repo"))).rejects.toThrow()
    expect(await readFile(join(wtDir, "a-ok.txt"), "utf8")).toBe("ok\n")
    expect(await readFile(locked, "utf8")).toBe("secret\n")
  })

  it("gives two same-day salvages of the same tip distinct archives; a failing second leaves the first intact", async () => {
    const { wtDir, salvageRoot, run } = await dirtyWorktree("twice")
    await symlink("somewhere", join(wtDir, "link"))
    const first = await run()
    const second = await run()
    expect(second.dir).not.toBe(first.dir)
    expect(second.dir.endsWith("-2")).toBe(true)
    expect(await readlink(join(second.dir, "untracked", "link"))).toBe("somewhere")

    if (process.getuid?.() !== 0) {
      const locked = join(wtDir, "locked.txt")
      await writeFile(locked, "x\n")
      await chmod(locked, 0o000)
      try {
        await expect(run()).rejects.toThrow()
      } finally {
        await chmod(locked, 0o644)
      }
      expect(await readdir(join(salvageRoot, "test-repo"))).toHaveLength(2)
      expect(await readlink(join(first.dir, "untracked", "link"))).toBe("somewhere")
      expect(JSON.parse(await readFile(join(first.dir, "MANIFEST.json"), "utf8")).symlinks).toHaveLength(1)
    }
  })

  it("restore never overwrites: existing paths are skipped and reported", async () => {
    const { wtDir, run } = await dirtyWorktree("norestore")
    await writeFile(join(wtDir, "f.txt"), "salvaged\n")
    await writeFile(join(wtDir, "g.txt"), "salvaged-g\n")
    await symlink("t", join(wtDir, "l"))
    const { dir } = await run()
    const fresh = await mkdtemp(join(tmpdir(), "wt-salvage-restore-"))
    cleanupPaths.push(fresh)
    await writeFile(join(fresh, "f.txt"), "keep me\n")
    await symlink("other", join(fresh, "l"))
    const res = await restoreSalvage(dir, fresh)
    expect(res.skipped.sort()).toEqual(["f.txt", "l"])
    expect(res).toMatchObject({ files: 1, symlinks: 0 })
    expect(await readFile(join(fresh, "f.txt"), "utf8")).toBe("keep me\n")
    expect(await readlink(join(fresh, "l"))).toBe("other")
    expect(await readFile(join(fresh, "g.txt"), "utf8")).toBe("salvaged-g\n")
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
