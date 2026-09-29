import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecResult } from "../exec.js"

/**
 * `execArgv` is mocked (not the real `cp` binary) so the argv-shape and
 * fallback-on-failure assertions below are deterministic across hosts. An
 * earlier version of this file forced `process.platform` and relied on the
 * REAL host `cp` binary disagreeing with the forced platform to exercise the
 * fallback path — that happened to work on a macOS dev box (BSD `cp` chokes
 * on `--reflink`, so forcing "linux" there triggered a genuine failure) but
 * broke on Linux CI, where GNU `cp` doesn't understand `-Rc` the way BSD
 * `cp` does, so forcing "darwin" there ALSO triggers an unplanned fallback —
 * the opposite direction, but still wrong for a test asserting exactly one
 * call. Mocking `execArgv`'s exit code directly removes the host dependency
 * entirely. The default implementation still delegates to the real
 * `execArgv` (see the `vi.mock` factory below), so the unforced tests below
 * still perform genuine copies through the host's real `cp`.
 */
const { execArgvMock } = vi.hoisted(() => ({ execArgvMock: vi.fn() }))
vi.mock("../exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../exec.js")>()
  return { ...actual, execArgv: execArgvMock }
})

// Captured once so `beforeEach` can re-arm the passthrough default after
// `mockClear()` — `mockClear()` also drops the implementation set on this
// mock (unlike a mock whose implementation was set outside an async `vi.mock`
// factory), so re-applying it per test is required, not just defensive.
const { execArgv: realExecArgv } = await vi.importActual<typeof import("../exec.js")>("../exec.js")

import { cloneEntries } from "../clone.js"
import { ProvisionCancelledError } from "../provision-scheduler.js"

const realPlatform = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true })
}
function once(exitCode: number, stderr = ""): void {
  execArgvMock.mockImplementationOnce(
    async (): Promise<ExecResult> => ({ exitCode, stdout: "", stderr }),
  )
}

describe("cloneEntries", () => {
  const cleanupPaths: string[] = []
  beforeEach(() => {
    execArgvMock.mockClear()
    execArgvMock.mockImplementation(realExecArgv)
  })
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

  it("an already-aborted signal throws ProvisionCancelledError before copying anything", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")
    const ac = new AbortController()
    ac.abort()

    await expect(cloneEntries(repoRoot, cwd, ["cache.db"], ac.signal)).rejects.toBeInstanceOf(
      ProvisionCancelledError,
    )
    expect(execArgvMock).not.toHaveBeenCalled()
  })

  it("a cp killed by an abort is a cancellation, not the clone-failed error or the fallback copy", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")
    const ac = new AbortController()
    execArgvMock.mockImplementationOnce(async (): Promise<ExecResult> => {
      ac.abort()
      return { exitCode: 143, stdout: "", stderr: "" }
    })

    await expect(cloneEntries(repoRoot, cwd, ["cache.db"], ac.signal)).rejects.toBeInstanceOf(
      ProvisionCancelledError,
    )
    expect(execArgvMock).toHaveBeenCalledTimes(1)
  })

  it("is a no-op when no pattern matches anything", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)

    await expect(cloneEntries(repoRoot, cwd, ["node_modules"])).resolves.toBeUndefined()
  })

  it("uses `cp -Rc` (clonefile) on darwin, one call, when it succeeds", async () => {
    setPlatform("darwin")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")

    once(0)
    await cloneEntries(repoRoot, cwd, ["cache.db"])

    expect(execArgvMock.mock.calls).toHaveLength(1)
    expect(execArgvMock.mock.calls[0]?.[0]).toBe("cp")
    expect(execArgvMock.mock.calls[0]?.[1]).toEqual(["-Rc", join(repoRoot, "cache.db"), join(cwd, "cache.db")])
  })

  it("uses `cp -r --reflink=auto` on linux, one call, when it succeeds", async () => {
    setPlatform("linux")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")

    once(0)
    await cloneEntries(repoRoot, cwd, ["cache.db"])

    expect(execArgvMock.mock.calls).toHaveLength(1)
    expect(execArgvMock.mock.calls[0]?.[0]).toBe("cp")
    expect(execArgvMock.mock.calls[0]?.[1]).toEqual([
      "-r",
      "--reflink=auto",
      join(repoRoot, "cache.db"),
      join(cwd, "cache.db"),
    ])
  })

  it("falls back to a plain `cp -R` when the platform's primary attempt fails", async () => {
    setPlatform("linux")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await mkdir(join(repoRoot, "node_modules"), { recursive: true })
    await writeFile(join(repoRoot, "node_modules", "dep.js"), "x\n")

    once(1, "reflink not supported")
    once(0)
    await cloneEntries(repoRoot, cwd, ["node_modules"])

    expect(execArgvMock.mock.calls).toHaveLength(2)
    expect(execArgvMock.mock.calls[0]?.[1]).toEqual([
      "-r",
      "--reflink=auto",
      join(repoRoot, "node_modules"),
      join(cwd, "node_modules"),
    ])
    expect(execArgvMock.mock.calls[1]?.[1]).toEqual(["-R", join(repoRoot, "node_modules"), join(cwd, "node_modules")])
  })

  it("throws a clear error naming the source path when both attempts fail", async () => {
    setPlatform("linux")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")

    once(1, "reflink not supported")
    once(1, "permission denied")

    await expect(cloneEntries(repoRoot, cwd, ["cache.db"])).rejects.toThrow(/clone of/)
    expect(execArgvMock.mock.calls).toHaveLength(2)
  })

  it("attempts no CoW flag at all on an unsupported platform, straight to plain copy", async () => {
    setPlatform("win32")
    const repoRoot = await mkdtemp(join(tmpdir(), "clone-src-"))
    cleanupPaths.push(repoRoot)
    const cwd = await mkdtemp(join(tmpdir(), "clone-dest-"))
    cleanupPaths.push(cwd)
    await writeFile(join(repoRoot, "cache.db"), "x\n")

    once(0)
    await cloneEntries(repoRoot, cwd, ["cache.db"])

    expect(execArgvMock.mock.calls).toHaveLength(1)
    expect(execArgvMock.mock.calls[0]?.[1]).toEqual(["-R", join(repoRoot, "cache.db"), join(cwd, "cache.db")])
  })
})
