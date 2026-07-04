import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandGlob } from "../glob.js"

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
