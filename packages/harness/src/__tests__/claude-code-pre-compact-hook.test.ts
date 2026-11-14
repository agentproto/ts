import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * The projected PreCompact hook: with `preCompactCommand`, the isolated
 * `<CLAUDE_CONFIG_DIR>/settings.json` written at every claude-code spawn
 * carries ONE `PreCompact` entry (matcher `auto`, synchronous, timeout 30)
 * running that command. Without it the file is exactly what it was before,
 * and since the file is rewritten whole at each spawn, a respawn without the
 * option drops the hook.
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
    async loadSession(params: { sessionId: string }) {
      return { sessionId: params.sessionId }
    },
  })),
}))

const { defineHarness, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition } from "../types.js"

const claudeCodeLike = (id = "claude-code"): AgentCliDefinition => ({
  name: id,
  id,
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/claude-agent-acp" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./claude-code-acp.ACP.md",
  modes: [
    { id: "default", description: "Standard interactive mode." },
    { id: "plan", description: "Plan-only.", bin_args_append: ["--permission-mode", "plan"] },
  ],
})

const COMMAND = "/opt/agentproto/bin/agentproto hook pre-compact"
/** The settings.json a claude-code spawn with no posture writes today. */
const BASELINE = JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: false } })

describe("P1 projected PreCompact hook in the isolated settings.json", () => {
  let baseDir: string
  let prevConfigDir: string | undefined
  beforeEach(() => {
    spawnCalls.length = 0
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    baseDir = mkdtempSync(join(tmpdir(), "pre-compact-hook-"))
  })
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    rmSync(baseDir, { recursive: true, force: true })
  })

  const settingsOf = (configDir: string): string => readFileSync(join(configDir, "settings.json"), "utf8")

  it("writes exactly one synchronous PreCompact entry, matcher auto, timeout 30, next to the existing keys", async () => {
    const configDir = join(baseDir, "sess_on")
    const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike()))
    await runtime.start({ cwd: "/scratch", configDir, preCompactCommand: COMMAND, config: { mode: "plan" } })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(JSON.parse(settingsOf(configDir))).toEqual({
      attribution: { commit: "", pr: "", sessionUrl: false },
      permissions: { defaultMode: "plan" },
      hooks: {
        PreCompact: [{ matcher: "auto", hooks: [{ type: "command", command: COMMAND, timeout: 30 }] }],
      },
    })
  })

  it("without the option the file is byte-identical to today's", async () => {
    const configDir = join(baseDir, "sess_off")
    const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike()))
    await runtime.start({ cwd: "/scratch", configDir })
    expect(settingsOf(configDir)).toBe(BASELINE)
  })

  it("a second spawn in the same dir with the option removed leaves no hook", async () => {
    const configDir = join(baseDir, "sess_again")
    const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike()))
    await runtime.start({ cwd: "/scratch", configDir, preCompactCommand: COMMAND })
    expect(JSON.parse(settingsOf(configDir)).hooks).toBeDefined()
    await runtime.start({ cwd: "/scratch", configDir })
    expect(settingsOf(configDir)).toBe(BASELINE)
  })

  it("an adapter other than claude-code gets no settings file at all", async () => {
    const configDir = join(baseDir, "sess_hermes")
    const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike("hermes")))
    await runtime.start({ cwd: "/scratch", configDir, preCompactCommand: COMMAND })
    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
