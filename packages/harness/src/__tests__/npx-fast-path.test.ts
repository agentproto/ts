import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { delimiter, join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import type { AgentCliDefinition } from "../types.js"

/**
 * F34b: a pinned `npx -y pkg@x.y.z` adapter must not pay `npm exec`'s
 * pre-run tree scans (and its per-package cross-process lock) on every
 * spawn — those made plain claude-code spawns wait minutes behind an
 * unrelated worktree provision's `pnpm install` on the same disk.
 */

const spawnCalls: Array<{ bin: string; args: string[]; opts: { env?: Record<string, string> } }> = []

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: { env?: Record<string, string> }) => {
    spawnCalls.push({ bin, args, opts })
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(),
    })
    queueMicrotask(() => child.emit("spawn"))
    return child
  }),
}))

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => ({
    sessionId: "acp-sess-1",
    async connect() {},
    async send() {},
    async *events() {},
    async cancel() {},
    async close() {},
  })),
}))

import { createAgentCliRuntime } from "../define-agent-cli.js"
import { npxCacheKey, resolveNpxFastPath } from "../npx-fast-path.js"

const PKG = "@agentclientprotocol/claude-agent-acp"
const SPEC = `${PKG}@0.81.2`

let cache: string

/** Lay out `<cache>/_npx/<hash>` the way `npx` itself leaves it. */
function seedNpxCache(spec: string, name: string, version: string, bin: unknown): string {
  const installDir = join(cache, "_npx", npxCacheKey([spec]))
  const pkgDir = join(installDir, "node_modules", name)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version, bin }))
  writeFileSync(join(pkgDir, "cli.js"), "#!/usr/bin/env node\n")
  const binDir = join(installDir, "node_modules", ".bin")
  mkdirSync(binDir, { recursive: true })
  const binNames = typeof bin === "string" ? [name.replace(/^@[^/]+\//, "")] : Object.keys(bin as object)
  for (const b of binNames) symlinkSync(join(pkgDir, "cli.js"), join(binDir, b))
  return binDir
}

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "npx-fast-path-"))
})

afterEach(() => {
  rmSync(cache, { recursive: true, force: true })
  spawnCalls.length = 0
  vi.unstubAllEnvs()
})

describe("npxCacheKey", () => {
  it("matches npm's own `_npx/<hash>` dir name for a real spec", () => {
    // Observed on disk: ~/.npm/_npx/698eb38f5d7f5a61 holds claude-agent-acp@0.81.2.
    expect(npxCacheKey([SPEC])).toBe("698eb38f5d7f5a61")
  })
})

describe("resolveNpxFastPath", () => {
  const env = () => ({ npm_config_cache: cache })

  it("resolves a cached exact-version spec to its bin, forwarding the rest of argv", () => {
    const binDir = seedNpxCache(SPEC, PKG, "0.81.2", { "claude-agent-acp": "cli.js" })
    const fast = resolveNpxFastPath("/usr/local/bin/npx", ["-y", SPEC, "--flag"], env(), { platform: "darwin" })
    expect(fast).toEqual({ bin: join(binDir, "claude-agent-acp"), args: ["--flag"], binDir })
  })

  it("picks the bin named after the unscoped package when there are several", () => {
    const binDir = seedNpxCache(SPEC, PKG, "0.81.2", { "claude-agent-acp": "cli.js", other: "cli.js" })
    expect(resolveNpxFastPath("npx", ["--yes", SPEC], env(), { platform: "darwin" })?.bin).toBe(
      join(binDir, "claude-agent-acp"),
    )
  })

  it("falls back to npx on a cache miss", () => {
    expect(resolveNpxFastPath("npx", ["-y", SPEC], env(), { platform: "darwin" })).toBeUndefined()
  })

  it("falls back when the cached version differs from the pin", () => {
    seedNpxCache(SPEC, PKG, "0.80.0", { "claude-agent-acp": "cli.js" })
    expect(resolveNpxFastPath("npx", ["-y", SPEC], env(), { platform: "darwin" })).toBeUndefined()
  })

  it("never bypasses an unpinned spec (npx's registry check is the update path)", () => {
    seedNpxCache("opencode-ai", "opencode-ai", "1.0.0", "cli.js")
    expect(resolveNpxFastPath("npx", ["-y", "opencode-ai", "acp"], env(), { platform: "darwin" })).toBeUndefined()
    expect(resolveNpxFastPath("npx", ["-y", `${PKG}@^0.81.0`], env(), { platform: "darwin" })).toBeUndefined()
  })

  it("leaves non-npx bins and argv without -y alone", () => {
    seedNpxCache(SPEC, PKG, "0.81.2", { "claude-agent-acp": "cli.js" })
    expect(resolveNpxFastPath("hermes", ["-y", SPEC], env(), { platform: "darwin" })).toBeUndefined()
    expect(resolveNpxFastPath("npx", [SPEC], env(), { platform: "darwin" })).toBeUndefined()
  })

  it("is off on Windows (.cmd shims)", () => {
    seedNpxCache(SPEC, PKG, "0.81.2", { "claude-agent-acp": "cli.js" })
    expect(resolveNpxFastPath("npx", ["-y", SPEC], env(), { platform: "win32" })).toBeUndefined()
  })
})

describe.skipIf(process.platform === "win32")("start() — pinned npx adapter", () => {
  const def = {
    name: "claude-code",
    id: "claude-code",
    description: "fake",
    version: "0.1.0",
    bin: "npx",
    bin_args: ["-y", SPEC],
    install: [{ method: "npm", package: PKG, global: true }],
    sandbox: "./SANDBOX.md",
    protocol: "acp",
    acp: "./claude.ACP.md",
  } as AgentCliDefinition

  it("execs the cached bin directly, with its .bin dir first on PATH", async () => {
    const binDir = seedNpxCache(SPEC, PKG, "0.81.2", { "claude-agent-acp": "cli.js" })
    vi.stubEnv("npm_config_cache", cache)
    await createAgentCliRuntime(def).start({ cwd: "/tmp" })
    expect(spawnCalls[0]?.bin).toBe(join(binDir, "claude-agent-acp"))
    expect(spawnCalls[0]?.args).toEqual([])
    expect(spawnCalls[0]?.opts.env?.PATH?.split(delimiter)[0]).toBe(binDir)
  })

  it("still spawns npx when the pinned version isn't cached yet", async () => {
    vi.stubEnv("npm_config_cache", cache)
    await createAgentCliRuntime(def).start({ cwd: "/tmp" })
    expect(spawnCalls[0]?.bin).toMatch(/npx$/)
    expect(spawnCalls[0]?.args).toEqual(["-y", SPEC])
  })
})
