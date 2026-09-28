import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const spawnSpy = vi.fn()
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args)
      return actual.spawn(...args)
    },
  }
})

import { cloneEntries } from "../clone.js"

/** Real platform is "darwin" here (we're on macOS) — tests that want to
 *  exercise the Linux argv/fallback path override it for the duration of
 *  one test and restore it in `afterEach`. */
const realPlatform = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

describe("cloneEntries", () => {
  const cleanupPaths: string[] = []
  beforeEach(() => spawnSpy.mockClear())
  afterEach(async () => {
    setPlatform(realPlatform)
    while (cleanupPaths.length) {
      const p = cleanupPaths.pop()!
      await rm(p, { recursive: true, force: true })
    }
  })

  it("clones a whole directory tree, byte-identical, never as a symlink", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)

    await mkdir(join(repoRoot, "node_modules", "dep"), { recursive: true })
    await writeFile(join(repoRoot, "node_modules", "dep", "index.js"), "module.exports = 1\n")

    await cloneEntries(repoRoot, cwd, ["node_modules"])

    const stat = await lstat(join(cwd, "node_modules"))
    expect(stat.isSymbolicLink()).toBe(false)
    const content = await readFile(join(cwd, "node_modules", "dep", "index.js"), "utf8")
    expect(content).toBe("module.exports = 1\n")
  })

  it("clones an independent copy — mutating the clone doesn't touch the source", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)

    await writeFile(join(repoRoot, "cache.db"), "original\n")
    await cloneEntries(repoRoot, cwd, ["cache.db"])
    await writeFile(join(cwd, "cache.db"), "mutated\n")

    const source = await readFile(join(repoRoot, "cache.db"), "utf8")
    expect(source).toBe("original\n")
  })

  it("skips an entry whose destination already exists — never clobbers", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)

    await writeFile(join(repoRoot, "cache.db"), "from-source\n")
    await writeFile(join(cwd, "cache.db"), "already-there\n")

    await cloneEntries(repoRoot, cwd, ["cache.db"])

    const content = await readFile(join(cwd, "cache.db"), "utf8")
    expect(content).toBe("already-there\n")
  })

  it("is a no-op when no pattern matches anything", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)

    await expect(cloneEntries(repoRoot, cwd, ["node_modules"])).resolves.toBeUndefined()
  })

  it("uses `cp -Rc` (clonefile) on darwin", async () => {
    setPlatform("darwin")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")

    await cloneEntries(repoRoot, cwd, ["cache.db"])

    const cpCalls = spawnSpy.mock.calls.filter((c) => c[0] === "cp")
    expect(cpCalls[0]?.[1]).toEqual(["-Rc", join(repoRoot, "cache.db"), join(cwd, "cache.db")])
    // macOS `cp -c` falls back to copyfile(2) internally on its own when
    // cloning isn't available — no second `cp` invocation needed here.
    expect(cpCalls).toHaveLength(1)
  })

  it("falls back to a plain copy when the platform's CoW attempt fails (e.g. --reflink=auto on a non-GNU cp)", async () => {
    // Forcing "linux" while actually running on macOS's BSD `cp` (which
    // doesn't understand `--reflink`) makes the primary attempt genuinely
    // fail — exercising the real fallback path, not a mocked one.
    setPlatform("linux")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await mkdir(join(repoRoot, "node_modules"), { recursive: true })
    await writeFile(join(repoRoot, "node_modules", "dep.js"), "x\n")

    await cloneEntries(repoRoot, cwd, ["node_modules"])

    const cpCalls = spawnSpy.mock.calls.filter((c) => c[0] === "cp")
    expect(cpCalls[0]?.[1]).toEqual([
      "-r",
      "--reflink=auto",
      join(repoRoot, "node_modules"),
      join(cwd, "node_modules"),
    ])
    expect(cpCalls[1]?.[1]).toEqual(["-R", join(repoRoot, "node_modules"), join(cwd, "node_modules")])
    expect(cpCalls).toHaveLength(2)

    const content = await readFile(join(cwd, "node_modules", "dep.js"), "utf8")
    expect(content).toBe("x\n")
  })

  // Skipped as root: permission bits don't restrict root, so the forced
  // failure this test relies on (an unwritable destination directory) would
  // never actually fail and the test would be asserting nothing.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  it.skipIf(isRoot)(
    "throws a clear error when both the clone attempt and the fallback fail",
    async () => {
      setPlatform("linux")
      const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
      cleanupPaths.push(repoRoot)
      const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
      cleanupPaths.push(cwd)
      await writeFile(join(repoRoot, "cache.db"), "x\n")

      const { chmod } = await import("node:fs/promises")
      // Read+execute only: `cp` can list `cwd` but can't create an entry in
      // it, so both the (forced-failing) reflink attempt and the plain-copy
      // fallback genuinely fail — a real double failure, not a mocked one.
      await chmod(cwd, 0o555)
      try {
        await expect(cloneEntries(repoRoot, cwd, ["cache.db"])).rejects.toThrow(/clone of/)
      } finally {
        await chmod(cwd, 0o755)
      }
    },
  )
})
