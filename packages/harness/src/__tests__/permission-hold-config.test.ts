import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * `AgentCliDefinition.permissionHoldConfig`: inline JSON config the driver
 * deep-merges into the CLI's config env var only for a `permissionHold`
 * session (codex's `request_user_input` feature flag), without dropping the
 * system-prompt channel's keys.
 */
const spawnCalls: Array<{ args: string[]; env: Record<string, string> }> = []
const acpCalls = vi.hoisted(() => ({
  newSession: [] as Array<Record<string, unknown>>,
  loadSession: [] as Array<Record<string, unknown>>,
}))

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
    spawn: vi.fn((_bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async close() {},
    async newSession(params: Record<string, unknown>) {
      acpCalls.newSession.push(params)
      return { sessionId: "sess-1", async close() {} }
    },
    async loadSession(params: Record<string, unknown>) {
      acpCalls.loadSession.push(params)
      return { sessionId: params.sessionId, async close() {} }
    },
    async setSessionConfigOption() {
      return {}
    },
  })),
}))
const { defineHarness, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition } from "../types.js"

const codexLike = (): AgentCliDefinition => ({
  name: "test-codex",
  id: "codex",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/codex-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/codex-acp" }],
  version_check: { cmd: "codex-acp --version", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
  systemPrompt: { via: "inline-config", env: "CODEX_CONFIG", key: "developer_instructions", shape: "text" },
  permissionHoldConfig: {
    env: "CODEX_CONFIG",
    entries: { features: { default_mode_request_user_input: true } },
  },
})

describe("permissionHoldConfig at spawn", () => {
  let base: string
  let saved: string | undefined
  beforeEach(() => {
    spawnCalls.length = 0
    base = mkdtempSync(join(tmpdir(), "agent-cli-hold-config-"))
    saved = process.env.CODEX_CONFIG
    delete process.env.CODEX_CONFIG
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_CONFIG
    else process.env.CODEX_CONFIG = saved
    rmSync(base, { recursive: true, force: true })
  })

  it("merges the entries into CODEX_CONFIG under permissionHold, keeping developer_instructions", async () => {
    const runtime = createAgentCliRuntime(defineHarness(codexLike()))
    await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text", permissionHold: true })
    expect(spawnCalls).toHaveLength(1)
    const config = JSON.parse(spawnCalls[0]!.env.CODEX_CONFIG!)
    expect(config.developer_instructions).toBe("AGENT.md text")
    expect(config.features).toEqual({ default_mode_request_user_input: true })
  })

  it("deep-merges into an existing features table instead of replacing it", async () => {
    process.env.CODEX_CONFIG = JSON.stringify({ features: { other_flag: true }, model: "m" })
    const runtime = createAgentCliRuntime(defineHarness(codexLike()))
    await runtime.start({ cwd: base, permissionHold: true })
    const config = JSON.parse(spawnCalls[0]!.env.CODEX_CONFIG!)
    expect(config).toEqual({
      features: { other_flag: true, default_mode_request_user_input: true },
      model: "m",
    })
  })

  it("adds nothing without permissionHold", async () => {
    const runtime = createAgentCliRuntime(defineHarness(codexLike()))
    await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
    const config = JSON.parse(spawnCalls[0]!.env.CODEX_CONFIG!)
    expect(config).toEqual({ developer_instructions: "AGENT.md text" })
  })

  it("leaves a non-JSON value untouched and warns", async () => {
    process.env.CODEX_CONFIG = "not json"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const runtime = createAgentCliRuntime(defineHarness(codexLike()))
    await runtime.start({ cwd: base, permissionHold: true })
    expect(spawnCalls[0]!.env.CODEX_CONFIG).toBe("not json")
    expect(warn.mock.calls.some(c => String(c[0]).includes("permission-hold config"))).toBe(true)
    warn.mockRestore()
  })
})
