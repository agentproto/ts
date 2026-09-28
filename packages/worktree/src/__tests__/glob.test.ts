import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandGlob, expandCloneGlob, GlobTraversalError } from "../glob.js"

// The large-tree fixture builds 2,500 files and the afterEach rmdir's them
// on a loaded external SSD — the default 5s per-test budget times out there.
vi.setConfig({ testTimeout: 60_000 })

describe("expandGlob", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("matches a top-level no-slash pattern without crashing on a large node_modules tree, and skips it entirely", async () => {
    const root = await mkdtemp(join(tmpdir(), "glob-largerepo-"))
    cleanupPaths.push(root)

    await writeFile(join(root, ".env"), "SECRET=1\n")

    const nodeModules = join(root, "node_modules")
    for (let i = 0; i < 50; i++) {
      const pkgDir = join(nodeModules, `pkg-${i}`)
      await mkdir(pkgDir, { recursive: true })
      for (let j = 0; j < 50; j++) {
        await writeFile(join(pkgDir, `file-${j}.js`), `// ${i}-${j}\n`)
      }
    }

    await mkdir(join(root, "real-target"), { recursive: true })
    await writeFile(join(root, "real-target", "marker.txt"), "hi\n")
    await symlink(join(root, "real-target"), join(nodeModules, "linked-dir"))

    const matches = await expandGlob(root, ".env")
    expect(matches).toEqual([".env"])
  })

  it("still matches a bounded nested pattern", async () => {
    const root = await mkdtemp(join(tmpdir(), "glob-bounded-"))
    cleanupPaths.push(root)

    await mkdir(join(root, "envs", "dev"), { recursive: true })
    await mkdir(join(root, "envs", "prod"), { recursive: true })
    await writeFile(join(root, "envs", "dev", ".env.local"), "A=1\n")
    await writeFile(join(root, "envs", "prod", ".env.local"), "B=2\n")
    await writeFile(join(root, "envs", "dev", "other.txt"), "nope\n")

    const matches = await expandGlob(root, "envs/**/.env.local")
    expect(matches.sort()).toEqual(["envs/dev/.env.local", "envs/prod/.env.local"])
  })
})

describe("expandCloneGlob", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("matches a whole directory as one unit, without descending into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)

    const nodeModules = join(root, "node_modules")
    for (let i = 0; i < 50; i++) {
      const pkgDir = join(nodeModules, `pkg-${i}`)
      await mkdir(pkgDir, { recursive: true })
      for (let j = 0; j < 50; j++) {
        await writeFile(join(pkgDir, `file-${j}.js`), `// ${i}-${j}\n`)
      }
    }
    await writeFile(join(root, ".env"), "SECRET=1\n")

    const matches = await expandCloneGlob(root, "node_modules")
    expect(matches).toEqual(["node_modules"])
  })

  it("matches a file entry too, not only directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    await writeFile(join(root, "cache.db"), "x\n")

    const matches = await expandCloneGlob(root, "cache.db")
    expect(matches).toEqual(["cache.db"])
  })

  it("expands a wildcard segment across sibling packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    await mkdir(join(root, "packages", "a", "node_modules"), { recursive: true })
    await mkdir(join(root, "packages", "b", "node_modules"), { recursive: true })
    await mkdir(join(root, "packages", "c"), { recursive: true })
    await writeFile(join(root, "packages", "a", "node_modules", "dep.js"), "1\n")

    const matches = await expandCloneGlob(root, "packages/*/node_modules")
    expect(matches.sort()).toEqual(["packages/a/node_modules", "packages/b/node_modules"])
  })

  it("returns no matches when the pattern doesn't exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    expect(await expandCloneGlob(root, "nope")).toEqual([])
    expect(await expandCloneGlob(root, "packages/*/node_modules")).toEqual([])
  })

  it("rejects a '..' segment as path traversal, before touching the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    await expect(expandCloneGlob(root, "../secrets")).rejects.toThrow(GlobTraversalError)
    await expect(expandCloneGlob(root, "node_modules/../../etc")).rejects.toThrow(
      GlobTraversalError,
    )
  })

  it("rejects an absolute pattern as path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    await expect(expandCloneGlob(root, "/etc/passwd")).rejects.toThrow(GlobTraversalError)
  })

  it("rejects '**' — a clone target must be a single named entry per level", async () => {
    const root = await mkdtemp(join(tmpdir(), "clone-glob-"))
    cleanupPaths.push(root)
    await expect(expandCloneGlob(root, "**/node_modules")).rejects.toThrow(/\*\*/)
  })
})
