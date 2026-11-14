import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"

/**
 * A credential spawn's isolated data home (`XDG_DATA_HOME=<configDir>/auth-data`)
 * is inherited by every tool the agent runs. pnpm >= 11 derives its store
 * from it, so before this each session built its own 5-6 GB store. The
 * driver now links known tool caches back to the operator's location and
 * records the dir's disposable paths for session GC. Spawns no real CLI.
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

function fakeChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  }) as unknown as ChildProcess
  queueMicrotask(() => child.emit("spawn"))
  return child
}

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ bin, args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return { sessionId: "sess-1" }
    },
  })),
}))

const { defineHarness, createAgentCliRuntime } = await import("../define-agent-cli.js")
const { linkSharedToolCaches, SHARED_TOOL_CACHES } = await import("../shared-tool-caches.js")
const { readSessionCacheManifest, recordSessionCachePaths, SESSION_CACHE_MANIFEST } = await import(
  "../session-cache-manifest.js"
)
import type { AgentCliDefinition, ResolvedAuthSpec } from "../types.js"
import { agentCliFrontmatterSchema } from "../schema.js"

const opencodeLike = (): AgentCliDefinition => ({
  name: "opencode",
  id: "opencode",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "opencode-ai", "acp"],
  install: [{ method: "npm", package: "opencode-ai" }],
  version_check: { cmd: "opencode --version", parse: "(\\d+)", range: ">=0.0.0" },
  auth: { ref: "./SECRETS.md", state: { env: ["OPENCODE_API_KEY"] } },
  credentialDataHome: { env: "XDG_DATA_HOME", disposable: ["opencode/snapshot", "opencode/log"] },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
})

const apiKeySpec = (): ResolvedAuthSpec => ({
  mode: "api-key",
  setEnv: "OPENCODE_API_KEY",
  credential: "k-test-credential",
  unsetEnv: ["OPENCODE_API_KEY"],
  explicit: true,
  enforce: "always",
})

const backendAvailable = resolveCommandSandbox() !== null

describe("shared tool caches under the credential data home", () => {
  let base: string
  let realData: string
  let prevData: string | undefined
  beforeEach(() => {
    spawnCalls.length = 0
    base = realpathSync(mkdtempSync(join(tmpdir(), "agent-cli-stc-")))
    realData = join(base, "operator-data")
    mkdirSync(realData, { recursive: true })
    prevData = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = realData
  })
  afterEach(() => {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevData
    rmSync(base, { recursive: true, force: true })
  })

  it("links the pnpm store of the isolated data home to the operator's store, keeping the data home itself isolated", async () => {
    const configDir = join(base, "adapter-config", "sess_1")
    await createAgentCliRuntime(defineHarness(opencodeLike())).start({ cwd: base, configDir, auth: apiKeySpec() })

    const dataHome = join(configDir, "auth-data")
    expect(spawnCalls[0]!.env.XDG_DATA_HOME).toBe(dataHome)
    const store = join(dataHome, "pnpm", "store")
    expect(lstatSync(store).isSymbolicLink()).toBe(true)
    expect(readlinkSync(store)).toBe(join(realData, "pnpm", "store"))
    // The CLI's own data (the console login) is not linked anywhere.
    expect(() => lstatSync(join(dataHome, "opencode"))).toThrow()
  })

  it("records the cache paths of the dir in the session cache manifest", async () => {
    const configDir = join(base, "adapter-config", "sess_2")
    await createAgentCliRuntime(defineHarness(opencodeLike())).start({ cwd: base, configDir, auth: apiKeySpec() })
    expect(readSessionCacheManifest(configDir)?.disposable).toEqual([
      "auth-data/opencode/log",
      "auth-data/opencode/snapshot",
      "auth-data/pnpm/store",
      "auth-data/uv/python",
    ])
  })

  it("is idempotent across respawns of a lineage and never deletes a store already in the dir", async () => {
    const configDir = join(base, "adapter-config", "sess_3")
    const legacy = join(configDir, "auth-data", "uv", "python")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "keep"), "x")
    const runtime = () => createAgentCliRuntime(defineHarness(opencodeLike()))
    await runtime().start({ cwd: base, configDir, auth: apiKeySpec() })
    await runtime().start({ cwd: base, configDir, auth: apiKeySpec() })
    expect(lstatSync(join(configDir, "auth-data", "pnpm", "store")).isSymbolicLink()).toBe(true)
    // A real dir from an earlier spawn stays (GC reclaims it once dead).
    expect(readFileSync(join(legacy, "keep"), "utf8")).toBe("x")
  })

  it("links nothing and records nothing for an ambient spawn", async () => {
    const configDir = join(base, "adapter-config", "sess_4")
    await createAgentCliRuntime(defineHarness(opencodeLike())).start({ cwd: base, configDir })
    expect(spawnCalls[0]!.env.XDG_DATA_HOME).toBe(realData)
    expect(() => lstatSync(join(configDir, SESSION_CACHE_MANIFEST))).toThrow()
  })

  it.runIf(backendAvailable)("keeps a confined spawn's caches per session (the operator's store is not granted) but records them", async () => {
    const configDir = join(base, "adapter-config", "sess_5")
    const app = join(base, "app")
    const runWs = join(base, "runs", "r1")
    for (const d of [app, runWs]) mkdirSync(d, { recursive: true })
    await createAgentCliRuntime(defineHarness(opencodeLike())).start({
      cwd: app,
      configDir,
      auth: apiKeySpec(),
      fsZones: { readOnly: [], writable: [runWs] },
    })
    expect(() => lstatSync(join(configDir, "auth-data", "pnpm", "store"))).toThrow()
    expect(readSessionCacheManifest(configDir)?.disposable).toContain("auth-data/pnpm/store")
  })
})

describe("linkSharedToolCaches", () => {
  let base: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "stc-unit-")))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("resolves the platform default when the ambient env has no XDG_DATA_HOME", () => {
    const pnpm = SHARED_TOOL_CACHES.XDG_DATA_HOME!.find(c => c.id === "pnpm-store")!
    expect(pnpm.real({ env: {}, home: "/h", platform: "darwin" })).toBe("/h/Library/pnpm/store")
    expect(pnpm.real({ env: {}, home: "/h", platform: "linux" })).toBe("/h/.local/share/pnpm/store")
    expect(pnpm.real({ env: { XDG_DATA_HOME: "/x" }, home: "/h", platform: "darwin" })).toBe("/x/pnpm/store")
    // A relative value is not a base dir the tool would honour.
    expect(pnpm.real({ env: { XDG_DATA_HOME: "rel" }, home: "/h", platform: "linux" })).toBe("/h/.local/share/pnpm/store")
  })

  it("replaces a stale link and skips when the ambient var already is the dir", () => {
    const dir = join(base, "auth-data")
    const first = linkSharedToolCaches({ dir, envVar: "XDG_DATA_HOME", ambientEnv: { XDG_DATA_HOME: join(base, "a") } })
    expect(first.linked).toContain("pnpm/store")
    linkSharedToolCaches({ dir, envVar: "XDG_DATA_HOME", ambientEnv: { XDG_DATA_HOME: join(base, "b") } })
    expect(readlinkSync(join(dir, "pnpm", "store"))).toBe(join(base, "b", "pnpm", "store"))

    const same = linkSharedToolCaches({ dir: join(base, "c"), envVar: "XDG_DATA_HOME", ambientEnv: { XDG_DATA_HOME: join(base, "c") } })
    expect(same.linked).toEqual([])
  })

  it("knows nothing for a var no cache derives from", () => {
    expect(linkSharedToolCaches({ dir: base, envVar: "CODEX_HOME", ambientEnv: {} })).toEqual({ linked: [], skipped: [] })
  })
})

describe("session cache manifest", () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "scm-"))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("unions paths across spawns and drops any path escaping the dir", () => {
    recordSessionCachePaths(base, ["auth-data/pnpm/store", "../etc", "/abs", "a/../../b"])
    recordSessionCachePaths(base, ["auth-data/opencode/log", "auth-data/pnpm/store/"])
    expect(readSessionCacheManifest(base)?.disposable).toEqual(["auth-data/opencode/log", "auth-data/pnpm/store"])
  })

  it("filters unsafe entries from a hand-edited manifest", () => {
    writeFileSync(join(base, SESSION_CACHE_MANIFEST), JSON.stringify({ version: 1, disposable: ["ok/x", "../../home", 3] }))
    expect(readSessionCacheManifest(base)?.disposable).toEqual(["ok/x"])
  })

  it("schema accepts relative disposable paths and rejects escaping ones", () => {
    const parse = (credentialDataHome: unknown) =>
      agentCliFrontmatterSchema.safeParse({ ...opencodeLike(), credentialDataHome }).success
    expect(parse({ env: "XDG_DATA_HOME", disposable: ["opencode/snapshot"] })).toBe(true)
    expect(parse({ env: "XDG_DATA_HOME", disposable: ["../x"] })).toBe(false)
    expect(parse({ env: "XDG_DATA_HOME", disposable: ["/abs"] })).toBe(false)
  })
})
