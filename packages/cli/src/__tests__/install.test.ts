/**
 * Tests for `agentproto install`'s adapter-package bootstrap behaviour.
 *
 * Covers the cold-install fix: when `resolveAdapter(slug)` fails because
 * the `@agentproto/adapter-<slug>` package isn't importable AND the slug
 * maps to a known catalog entry, the verb runs `npm i -g <pkg>` itself
 * instead of dying with "Install it with: npm i -g …".
 *
 * Driven through the public `runInstall` entrypoint. Mocks:
 *   - `../registry/resolve.js` → `resolveAdapter` (control success/failure)
 *   - `node:child_process` → `spawn` (capture npm/shell invocations)
 *   - `./setup.js` → `runSetup` (no-op; we don't exercise the setup pipeline)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { resolveAdapterMock, spawnMock, runSetupMock } = vi.hoisted(() => ({
  resolveAdapterMock: vi.fn(),
  spawnMock: vi.fn(),
  runSetupMock: vi.fn(),
}))

vi.mock("../registry/resolve.js", () => ({
  resolveAdapter: resolveAdapterMock,
  // Not exercised here; stub to avoid pulling the real lister.
  listInstalledAdapters: vi.fn(async () => []),
  listAdaptersWithCatalog: vi.fn(async () => []),
}))
vi.mock("node:child_process", async importOriginal => {
  const actual =
    await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: spawnMock }
})
vi.mock("../commands/setup.js", () => ({
  runSetup: runSetupMock,
}))

import { runInstall } from "../commands/install.js"

/** A minimal fake AgentCliHandle with no install steps — the bootstrap path
 *  only needs `handle.install` and `handle.version_check` to be readable. */
function fakeHandle(slug: string) {
  return {
    slug,
    handle: {
      name: slug,
      install: [],
      version_check: undefined,
    },
    source: "npm" as const,
    packageName: `@agentproto/adapter-${slug}`,
  }
}

/** "could not load adapter" error matching resolveAdapter's real throw. */
function missingPackageError(slug: string): Error {
  const pkg = `@agentproto/adapter-${slug}`
  return new Error(
    `agentproto: could not load adapter '${slug}'. ` +
      `Tried '${pkg}'. Install it with: npm i -g ${pkg}\n  cause: Cannot find package '${pkg}'`
  )
}

/** Capture stdout/stderr writes into arrays. */
function captureStdio(): {
  out: string[]
  err: string[]
  restore: () => void
} {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((c: unknown) => {
      out.push(String(c))
      return true
    })
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((c: unknown) => {
      err.push(String(c))
      return true
    })
  return { out, err, restore: () => {
    outSpy.mockRestore()
    errSpy.mockRestore()
  } }
}

/** spawn stub: returns a fake child that fires `exit` with the given code. */
function spawnExits(code: number) {
  spawnMock.mockImplementation(() => {
    const child = {
      on: (event: string, cb: (c: number) => void) => {
        if (event === "exit") queueMicrotask(() => cb(code))
        return child
      },
      once: (event: string, cb: (c: number) => void) => {
        if (event === "exit") queueMicrotask(() => cb(code))
        return child
      },
      stdout: { on: () => {}, setEncoding: () => ({ on: () => {} }) },
      stderr: { on: () => {}, setEncoding: () => ({ on: () => {} }) },
      unref: () => {},
    }
    return child
  })
}

beforeEach(() => {
  resolveAdapterMock.mockReset()
  spawnMock.mockReset()
  runSetupMock.mockReset()
  runSetupMock.mockResolvedValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("agentproto install — adapter package bootstrap", () => {
  it("dry-run on a missing known adapter prints the bootstrap line and exits 0", async () => {
    resolveAdapterMock.mockRejectedValue(missingPackageError("claude-code"))
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["claude-code", "--dry-run"])

    expect(code).toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
    const stdout = io.out.join("")
    expect(stdout).toMatch(/would run: npm i -g @agentproto\/adapter-claude-code/)
    io.restore()
  })

  it("runs `npm i -g` then re-resolves when the adapter is missing and not --dry-run", async () => {
    // First resolve fails (package missing); the retry after `npm i -g`
    // succeeds.
    resolveAdapterMock
      .mockRejectedValueOnce(missingPackageError("claude-code"))
      .mockResolvedValueOnce(fakeHandle("claude-code"))
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, argv] = spawnMock.mock.calls[0]!
    expect(cmd).toBe("npm")
    expect(argv).toEqual(["install", "-g", "@agentproto/adapter-claude-code"])
    expect(resolveAdapterMock).toHaveBeenCalledTimes(2)
    const stdout = io.out.join("")
    expect(stdout).toMatch(/\[bootstrap\] installing @agentproto\/adapter-claude-code/)
    io.restore()
  })

  it("does NOT npm-install when the adapter is already resolvable (even with --dry-run)", async () => {
    // Adapter resolves on the first try → bootstrap path never engages.
    resolveAdapterMock.mockResolvedValue(fakeHandle("claude-code"))
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["claude-code", "--dry-run"])

    expect(code).toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1)
    const stdout = io.out.join("")
    expect(stdout).not.toMatch(/bootstrap/)
    io.restore()
  })

  it("surfaces the npm failure code and the manual install hint", async () => {
    resolveAdapterMock.mockRejectedValue(missingPackageError("claude-code"))
    spawnExits(42) // npm install fails
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(42)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const stderr = io.err.join("")
    expect(stderr).toMatch(/npm i -g @agentproto\/adapter-claude-code failed/)
    expect(stderr).toMatch(/Install it manually/)
    io.restore()
  })

  it("rethrows non-missing-package errors unchanged (no bootstrap attempt)", async () => {
    resolveAdapterMock.mockRejectedValue(
      new Error("agentproto: invalid adapter slug 'BadSlug'")
    )
    spawnExits(0)
    const io = captureStdio()

    await expect(runInstall(["bogus"])).rejects.toThrow(/invalid adapter slug/)
    expect(spawnMock).not.toHaveBeenCalled()
    io.restore()
  })
})
