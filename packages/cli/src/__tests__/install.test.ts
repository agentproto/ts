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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { resolveAdapterMock, spawnMock, runSetupMock, binOnPathMock, commandOnPathMock } =
  vi.hoisted(() => ({
    resolveAdapterMock: vi.fn(),
    spawnMock: vi.fn(),
    runSetupMock: vi.fn(),
    binOnPathMock: vi.fn(),
    commandOnPathMock: vi.fn(),
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
// The `vendored` install step (generic ACP agents) checks whether the bin is
// already on PATH before running its hint, and — for a shell-hint (uv/pip/…)
// — whether that package manager itself is on PATH. Mocked so these tests
// never depend on what's actually installed on the machine running them.
vi.mock("../registry/acp-generic.js", () => ({
  binOnPath: binOnPathMock,
}))
vi.mock("../registry/install-hint.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../registry/install-hint.js")>()
  return { ...actual, commandOnPath: commandOnPathMock }
})

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

// A successful install now enrolls the adapter in `config.json`, so every
// suite pins AGENTPROTO_HOME (and HOME) to a throwaway dir — never the
// developer's real ~/.agentproto.
let suiteHome: string
let suitePrevAgentprotoHome: string | undefined
let suitePrevHome: string | undefined

beforeEach(() => {
  suiteHome = mkdtempSync(join(tmpdir(), "agp-install-suite-"))
  suitePrevAgentprotoHome = process.env.AGENTPROTO_HOME
  suitePrevHome = process.env.HOME
  process.env.HOME = suiteHome
  process.env.AGENTPROTO_HOME = join(suiteHome, ".agentproto")
  resolveAdapterMock.mockReset()
  spawnMock.mockReset()
  runSetupMock.mockReset()
  runSetupMock.mockResolvedValue(0)
  binOnPathMock.mockReset()
  binOnPathMock.mockResolvedValue(false)
  commandOnPathMock.mockReset()
  commandOnPathMock.mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (suitePrevAgentprotoHome === undefined) delete process.env.AGENTPROTO_HOME
  else process.env.AGENTPROTO_HOME = suitePrevAgentprotoHome
  if (suitePrevHome === undefined) delete process.env.HOME
  else process.env.HOME = suitePrevHome
  rmSync(suiteHome, { recursive: true, force: true })
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
    expect(stdout).toMatch(/\[bootstrap\] running: npm i -g @agentproto\/adapter-claude-code/)
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

  it("reports a broken package when the post-install re-resolve still fails", async () => {
    resolveAdapterMock
      .mockRejectedValueOnce(missingPackageError("claude-code"))
      .mockRejectedValueOnce(new Error("package export is invalid"))
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(1)
    const stderr = io.err.join("")
    expect(stderr).toMatch(/installed but could not be loaded/)
    expect(stderr).toMatch(/valid package\.json export/)
    expect(stderr).not.toMatch(/install manually/)
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

/** A resolved generic-ACP handle (acp-generic.ts's `acpHandleFromSpec`
 *  shape) — a single `vendored` install step + the hint stashed at
 *  `metadata.acpGeneric.install_hint`, matching mistral-vibe/kimi-cli/etc. */
function fakeGenericAcpHandle(slug: string, bin: string, hint: string) {
  return {
    slug,
    handle: {
      name: slug,
      install: [{ method: "vendored" as const, path: bin }],
      version_check: undefined,
      metadata: { acpGeneric: { install_hint: hint } },
    },
    source: "acp-catalog" as const,
  }
}

describe("agentproto install — vendored (generic ACP) step", () => {
  it("already on PATH ⇒ no-op success, no hint command run", async () => {
    resolveAdapterMock.mockResolvedValue(
      fakeGenericAcpHandle("mistral-vibe", "vibe-acp", "uv tool install mistral-vibe")
    )
    binOnPathMock.mockResolvedValue(true)
    const io = captureStdio()

    const code = await runInstall(["mistral-vibe"])

    expect(code).toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(io.out.join("")).toMatch(/already on PATH/)
    io.restore()
  })

  it("not on PATH ⇒ runs the shell-hint's package manager (this is the mistral-vibe fix)", async () => {
    resolveAdapterMock.mockResolvedValue(
      fakeGenericAcpHandle("mistral-vibe", "vibe-acp", "uv tool install mistral-vibe")
    )
    binOnPathMock.mockResolvedValue(false)
    commandOnPathMock.mockReturnValue(true)
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["mistral-vibe"])

    expect(code).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, argv] = spawnMock.mock.calls[0]!
    expect(cmd).toBe("uv")
    expect(argv).toEqual(["tool", "install", "mistral-vibe"])
    io.restore()
  })

  it("does not persist a phantom @agentproto/adapter-<slug> id for a generic ACP agent", async () => {
    resolveAdapterMock.mockResolvedValue(
      fakeGenericAcpHandle("mistral-vibe", "vibe-acp", "uv tool install mistral-vibe")
    )
    binOnPathMock.mockResolvedValue(true)
    const io = captureStdio()

    const code = await runInstall(["mistral-vibe"])
    io.restore()

    expect(code).toBe(0)
    let adapters: string[] = []
    try {
      const cfg = JSON.parse(
        readFileSync(join(process.env.AGENTPROTO_HOME!, "config.json"), "utf8")
      ) as { adapters?: string[] }
      adapters = cfg.adapters ?? []
    } catch {
      // no config written at all — also correct
    }
    expect(adapters).not.toContain("@agentproto/adapter-mistral-vibe")
  })

  it("not on PATH ⇒ npm-hint runs `npm install -g`", async () => {
    resolveAdapterMock.mockResolvedValue(
      fakeGenericAcpHandle("gemini-cli", "gemini", "npm install -g @google/gemini-cli")
    )
    binOnPathMock.mockResolvedValue(false)
    spawnExits(0)
    const io = captureStdio()

    const code = await runInstall(["gemini-cli"])

    expect(code).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, argv] = spawnMock.mock.calls[0]!
    expect(cmd).toBe("npm")
    expect(argv).toEqual(["install", "-g", "@google/gemini-cli"])
    io.restore()
  })

  it("hint's package manager itself missing ⇒ clear failure, no spawn attempted", async () => {
    resolveAdapterMock.mockResolvedValue(
      fakeGenericAcpHandle("mistral-vibe", "vibe-acp", "uv tool install mistral-vibe")
    )
    binOnPathMock.mockResolvedValue(false)
    commandOnPathMock.mockReturnValue(false)
    const io = captureStdio()

    const code = await runInstall(["mistral-vibe"])

    expect(code).not.toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(io.err.join("")).toMatch(/'uv' is not installed/)
    io.restore()
  })

  it("no install_hint and not on PATH ⇒ 'install manually' failure (true BYO binary)", async () => {
    resolveAdapterMock.mockResolvedValue({
      slug: "some-byo-cli",
      handle: {
        name: "some-byo-cli",
        install: [{ method: "vendored" as const, path: "some-byo-cli" }],
        version_check: undefined,
      },
      source: "acp-catalog" as const,
    })
    binOnPathMock.mockResolvedValue(false)
    const io = captureStdio()

    const code = await runInstall(["some-byo-cli"])

    expect(code).not.toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(io.err.join("")).toMatch(/bring-your-own/)
    io.restore()
  })
})

/** A claude-code-shaped first-party handle: one `npm -g` install step and a
 *  LOCAL presence probe (`npm ls -g … --depth=0`), matching the fixed
 *  manifest. The old `npm view … version` registry query can never fail, so
 *  it reported "already installed" on machines with nothing installed. */
function fakeClaudeCodeHandle() {
  return {
    slug: "claude-code",
    handle: {
      name: "claude-code",
      install: [
        {
          method: "npm" as const,
          package: "@agentclientprotocol/claude-agent-acp",
          global: true,
        },
      ],
      version_check: {
        cmd: "npm ls -g @agentclientprotocol/claude-agent-acp --depth=0",
        parse: "(\\d+\\.\\d+\\.\\d+)",
      },
    },
    source: "npm" as const,
    packageName: "@agentproto/adapter-claude-code",
  }
}

/** spawn stub dispatching on the invoked command: the version_check probe
 *  runs `bash -lc <cmd>` (stdio pipes); the install step runs `npm install`.
 */
function spawnDispatch(bash: { code: number; stdout?: string }) {
  spawnMock.mockImplementation((cmd: string) => {
    if (cmd === "bash") {
      return {
        on: () => {},
        once: (event: string, cb: (c: number) => void) => {
          if (event === "exit") queueMicrotask(() => cb(bash.code))
          return undefined
        },
        stdout: {
          on: (_e: string, cb: (c: Buffer) => void) =>
            cb(Buffer.from(bash.stdout ?? "")),
        },
        stderr: { on: () => {} },
        unref: () => {},
      }
    }
    const child = {
      on: () => {},
      once: (event: string, cb: (c: number) => void) => {
        if (event === "exit") queueMicrotask(() => cb(0))
        return child
      },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      unref: () => {},
    }
    return child
  })
}

describe("agentproto install — version_check presence gating", () => {
  it("a failing (missing-binary) presence check does NOT short-circuit to already-installed", async () => {
    // `npm ls -g <pkg> --depth=0` exits 1 when the package is absent — the
    // virgin-machine case the registry query (`npm view`) lied about.
    resolveAdapterMock.mockResolvedValue(fakeClaudeCodeHandle())
    spawnDispatch({ code: 1 })
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(0)
    // The install step ran: the planner did NOT take the already-installed
    // exit.
    const npmCall = spawnMock.mock.calls.find(([c]) => c === "npm")
    expect(npmCall).toBeDefined()
    expect(npmCall![1]).toEqual([
      "install",
      "-g",
      "@agentclientprotocol/claude-agent-acp",
    ])
    expect(io.out.join("")).not.toMatch(/already installed/)
    io.restore()
  })

  it("a passing presence check still short-circuits to already-installed", async () => {
    resolveAdapterMock.mockResolvedValue(fakeClaudeCodeHandle())
    spawnDispatch({
      code: 0,
      stdout: "`-- @agentclientprotocol/claude-agent-acp@0.75.1\n",
    })
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(0)
    expect(spawnMock.mock.calls.find(([c]) => c === "npm")).toBeUndefined()
    expect(io.out.join("")).toMatch(/already installed \(version 0\.75\.1\)/)
    io.restore()
  })
})

describe("agentproto install — enables the adapter (install == adapters install)", () => {
  let home: string
  let prevHome: string | undefined
  let prevAgentprotoHome: string | undefined

  beforeEach(() => {
    prevHome = process.env.HOME
    prevAgentprotoHome = process.env.AGENTPROTO_HOME
    home = mkdtempSync(join(tmpdir(), "agentproto-install-enable-"))
    process.env.HOME = home
    process.env.AGENTPROTO_HOME = join(home, ".agentproto")
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevAgentprotoHome === undefined) delete process.env.AGENTPROTO_HOME
    else process.env.AGENTPROTO_HOME = prevAgentprotoHome
    rmSync(home, { recursive: true, force: true })
  })

  function readConfig(): { adapters?: string[]; defaults?: { adapters?: Record<string, { auth?: { mode?: string } }> } } {
    return JSON.parse(
      readFileSync(join(home, ".agentproto", "config.json"), "utf8"),
    )
  }

  it("adds the adapter package to config.adapters after a successful install", async () => {
    resolveAdapterMock.mockResolvedValue(fakeHandle("claude-code"))
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(0)
    expect(readConfig().adapters).toEqual(["@agentproto/adapter-claude-code"])
    expect(io.out.join("")).toMatch(/enabled '@agentproto\/adapter-claude-code'/)
    io.restore()
  })

  it("writes api-key auth when a matching provider key is already stored", async () => {
    resolveAdapterMock.mockResolvedValue({
      ...fakeHandle("claude-code"),
      handle: {
        ...fakeHandle("claude-code").handle,
        provider: "anthropic",
      },
    })
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(
      join(home, ".agentproto", "providers.json"),
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { apiKey: "sk-ant-test", updatedAt: new Date().toISOString() },
        },
      }),
    )
    const io = captureStdio()

    const code = await runInstall(["claude-code"])

    expect(code).toBe(0)
    expect(readConfig().defaults?.adapters?.["claude-code"]?.auth?.mode).toBe(
      "api-key",
    )
    io.restore()
  })

  it("does not touch config on --dry-run", async () => {
    resolveAdapterMock.mockResolvedValue(fakeHandle("claude-code"))
    const io = captureStdio()

    const code = await runInstall(["claude-code", "--dry-run"])

    expect(code).toBe(0)
    expect(() => readConfig()).toThrow()
    expect(io.out.join("")).toMatch(/would enable '@agentproto\/adapter-claude-code'/)
    io.restore()
  })
})
