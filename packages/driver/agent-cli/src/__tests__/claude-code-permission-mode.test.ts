import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { readFileSync, existsSync } from "node:fs"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the `CLAUDE_CONFIG_DIR` permission-mode override
 * (see the comment in `define-agent-cli.ts` above `resolveClaudeCodePermissionMode`
 * and `adapters/claude-code/src/index.ts` above `modes`): claude-code's ACP
 * wrapper ignores `--permission-mode` on argv, so a requested non-default
 * mode only takes effect via a per-session `CLAUDE_CONFIG_DIR` pointed at a
 * throwaway settings.json. Empirically confirmed live (see PLAN write-up);
 * this test locks in the spawn-time mechanics without spawning a real CLI.
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

function fakeChild(): ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  } as unknown as ChildProcess
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

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition } from "../types.js"

const claudeCodeLike = (): AgentCliDefinition => ({
  name: "claude-code",
  id: "claude-code",
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
    {
      id: "bypass-permissions",
      description: "Skip prompts.",
      bin_args_append: ["--permission-mode", "bypassPermissions"],
    },
  ],
})

describe("claude-code CLAUDE_CONFIG_DIR permission-mode override", () => {
  // The child env is built by spreading `process.env` (define-agent-cli.ts's
  // `filterStringEnv(process.env)`), so an AMBIENT CLAUDE_CONFIG_DIR is
  // inherited straight into `spawnCalls[].env` and the "does not set it"
  // assertions below read the runner's environment instead of the override's
  // behaviour. That is not hypothetical: the daemon implements claude-code's
  // `mode:` by setting exactly this variable, so any agent session running
  // the gate under a non-default mode failed these three tests — a red gate
  // in a package the agent's diff never touched. Neutralise it here (same
  // save/restore shape claude-code-auth-mode.test.ts uses for the
  // ANTHROPIC_* vars) so the suite pins the override, not the shell.
  let prevConfigDir: string | undefined
  beforeEach(() => {
    spawnCalls.length = 0
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  })

  it("writes a temp CLAUDE_CONFIG_DIR/settings.json and points the child env at it for mode:plan", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "plan" } })

    expect(spawnCalls).toHaveLength(1)
    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR
    expect(configDir).toBeTruthy()
    const settingsPath = `${configDir}/settings.json`
    expect(existsSync(settingsPath)).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      permissions: { defaultMode: "plan" },
    })
  })

  it("maps mode:bypass-permissions to the same settings.json vocabulary", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "bypass-permissions" } })

    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
    expect(JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
    })
  })

  it("does not set CLAUDE_CONFIG_DIR when no mode is requested", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch" })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("does not set CLAUDE_CONFIG_DIR when mode:default is requested explicitly", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "default" } })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("does not apply the override for a non-claude-code adapter, even with an identical bin_args_append shape", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "hermes",
      name: "hermes",
    })
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "plan" } })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
