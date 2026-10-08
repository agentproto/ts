import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import type { AgentCliDefinition } from "../types.js"
import { agentCliFrontmatterSchema } from "../schema.js"

/**
 * `stateHome` at the driver seam: an OS-confined spawn of a CLI that keeps
 * state under `$HOME` (codex) gets an isolated home with only the login file
 * linked back, and the sandbox grants exactly those paths. Spawns no real CLI.
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

vi.mock("node:child_process", async (importOriginal) => {
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

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")

const codexLike = (): AgentCliDefinition => ({
  name: "codex",
  id: "codex",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/codex-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/codex-acp" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  stateHome: { env: "CODEX_HOME", defaultDir: ".codex", share: ["auth.json"] },
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
})

const backendAvailable = resolveCommandSandbox() !== null

describe("stateHome: isolated adapter home for confined spawns", () => {
  let prevHome: string | undefined
  let base: string
  let realHome: string
  let app: string
  let runWs: string
  beforeEach(() => {
    spawnCalls.length = 0
    prevHome = process.env.CODEX_HOME
    base = realpathSync(mkdtempSync(join(tmpdir(), "agent-cli-state-home-")))
    realHome = join(base, "real-codex")
    app = join(base, "app")
    runWs = join(base, "runs", "r1")
    for (const d of [realHome, app, runWs]) mkdirSync(d, { recursive: true })
    writeFileSync(join(realHome, "auth.json"), '{"tokens":{}}')
    writeFileSync(join(realHome, "config.toml"), 'model = "x"')
    // The operator's real home, as the ambient env names it.
    process.env.CODEX_HOME = realHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevHome
    rmSync(base, { recursive: true, force: true })
  })

  it.runIf(backendAvailable)(
    "points CODEX_HOME at the session config dir, links only auth.json, and grants exactly those paths",
    async () => {
      const configDir = join(base, "adapter-config", "sess_1")
      const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
      await runtime.start({ cwd: app, configDir, fsZones: { readOnly: [], writable: [runWs] } })

      const call = spawnCalls[0]!
      expect(["sandbox-exec", "bwrap"]).toContain(call.bin)
      expect(call.env.CODEX_HOME).toBe(configDir)
      const link = join(configDir, "auth.json")
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(realHome, "auth.json"))
      // config.toml (MCP servers, sandbox mode) stays out of reach.
      expect(() => lstatSync(join(configDir, "config.toml"))).toThrow()

      const argv = call.args.join("\n")
      expect(argv).toContain(configDir)
      expect(argv).toContain(join(realHome, "auth.json"))
      if (call.bin === "sandbox-exec") {
        // Never the real home as a whole.
        expect(argv).not.toContain(`(subpath "${realHome}")`)
      } else {
        expect(call.args).not.toContain(realHome)
      }
    },
  )

  it.runIf(backendAvailable)("re-asserts the link over a regular file left in a reused config dir", async () => {
    const configDir = join(base, "adapter-config", "sess_2")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "auth.json"), '{"stale":true}')
    const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
    await runtime.start({ cwd: app, configDir, fsZones: { readOnly: [], writable: [runWs] } })
    expect(lstatSync(join(configDir, "auth.json")).isSymbolicLink()).toBe(true)
  })

  it.runIf(backendAvailable)(
    "writes seed files into the isolated home, never through a link into the real one",
    async () => {
      const configDir = join(base, "adapter-config", "sess_4")
      mkdirSync(configDir, { recursive: true })
      // A reused dir holding a link to the operator's config must not be written through.
      symlinkSync(join(realHome, "config.toml"), join(configDir, "config.toml"))
      const def = codexLike()
      def.stateHome = { ...def.stateHome!, seed: { "config.toml": "project_root_markers = []\n" } }
      const runtime = createAgentCliRuntime(defineAgentCli(def))
      await runtime.start({ cwd: app, configDir, fsZones: { readOnly: [], writable: [runWs] } })

      const seeded = join(configDir, "config.toml")
      expect(lstatSync(seeded).isSymbolicLink()).toBe(false)
      expect(readFileSync(seeded, "utf8")).toBe("project_root_markers = []\n")
      expect(readFileSync(join(realHome, "config.toml"), "utf8")).toBe('model = "x"')
    },
  )

  it("leaves an unconfined spawn on the operator's own home", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
    await runtime.start({ cwd: app, configDir: join(base, "adapter-config", "sess_3") })
    const call = spawnCalls[0]!
    expect(call.bin).not.toBe("sandbox-exec")
    expect(call.env.CODEX_HOME).toBe(realHome)
  })
})

describe("stateHome schema", () => {
  const parse = (stateHome: unknown) =>
    agentCliFrontmatterSchema.safeParse({ ...codexLike(), stateHome }).success

  it("accepts the codex declaration", () => {
    expect(parse({ env: "CODEX_HOME", defaultDir: ".codex", share: ["auth.json"] })).toBe(true)
    expect(
      parse({ env: "CODEX_HOME", defaultDir: ".codex", share: ["auth.json"], seed: { "config.toml": "project_root_markers = []\n" } }),
    ).toBe(true)
  })

  it("rejects a home outside $HOME and nested share paths", () => {
    expect(parse({ env: "CODEX_HOME", defaultDir: "../etc" })).toBe(false)
    expect(parse({ env: "CODEX_HOME", defaultDir: "/etc" })).toBe(false)
    expect(parse({ env: "CODEX_HOME", defaultDir: ".codex", share: ["../x"] })).toBe(false)
    expect(parse({ env: "CODEX_HOME", defaultDir: ".codex", seed: { "a/config.toml": "" } })).toBe(false)
    expect(parse({ env: "CODEX_HOME", defaultDir: ".codex", seed: { "..": "" } })).toBe(false)
  })
})
