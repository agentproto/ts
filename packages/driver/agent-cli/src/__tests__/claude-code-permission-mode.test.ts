import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { readFileSync, existsSync } from "node:fs"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the `CLAUDE_CONFIG_DIR` isolation override (see
 * the comment in `define-agent-cli.ts` above `isolateClaudeCodeConfig` and
 * above `resolveClaudeCodePermissionMode`, and `adapters/claude-code/src/index.ts`
 * above `modes`).
 *
 * Two things ride on this same `CLAUDE_CONFIG_DIR` mechanism, and this file
 * covers both:
 *
 * 1. Permission-mode override: claude-code's ACP wrapper ignores
 *    `--permission-mode` on argv, so a requested non-default mode only
 *    takes effect via a per-session `CLAUDE_CONFIG_DIR` pointed at a
 *    throwaway settings.json. Empirically confirmed live (see PLAN
 *    write-up).
 * 2. Ambient-config isolation: EVERY claude-code spawn through this path —
 *    not just ones that requested a posture/mode — must get an isolated
 *    `CLAUDE_CONFIG_DIR` with an explicit empty `mcpServers`, so a caller
 *    that never passes `posture` doesn't inherit the daemon's own
 *    `~/.claude.json` (and every globally-registered MCP server in it,
 *    including one that could point straight back at this daemon's
 *    `agent_start`). Verified against `@anthropic-ai/claude-agent-sdk`'s
 *    bundled `sdk.mjs`: the SDK resolves its global config file (the one
 *    carrying `mcpServers`) as `$CLAUDE_CONFIG_DIR/.claude.json`, never the
 *    real `~/.claude.json` once `CLAUDE_CONFIG_DIR` is set.
 *
 * These tests spawn no real CLI — they lock in the spawn-time mechanics
 * (env + temp-file writes) only.
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
    { id: "lean", description: "Lean context.", kind: "context", env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" } },
    { id: "plan", description: "Plan-only.", bin_args_append: ["--permission-mode", "plan"] },
    {
      id: "bypass-permissions",
      description: "Skip prompts.",
      bin_args_append: ["--permission-mode", "bypassPermissions"],
    },
  ],
})

describe("claude-code CLAUDE_CONFIG_DIR isolation + permission-mode override", () => {
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
    // The ambient-isolation write happens alongside the permission-mode
    // write, not instead of it.
    expect(JSON.parse(readFileSync(`${configDir}/.claude.json`, "utf8"))).toEqual({
      mcpServers: {},
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

  it("applies decomposed posture and contextProfile independently", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({
      cwd: "/scratch",
      posture: "bypass",
      contextProfile: "lean",
    })

    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
    expect(JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
    })
    expect(spawnCalls[0]!.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe("1")
  })

  it("still isolates CLAUDE_CONFIG_DIR (no posture, no ambient mcpServers) when no mode is requested", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch" })

    // This is the bug this test guards against: a caller with no opinion on
    // posture (the common, unremarkable case — most callers of
    // `agent_start` / `spawnAgentSession` never pass `posture`) must still
    // get an isolated CLAUDE_CONFIG_DIR. Before the fix this was
    // `undefined`, so the child inherited the daemon's own ambient
    // `process.env` and, through it, the real `~/.claude.json` — including
    // every globally-registered MCP server.
    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR
    expect(configDir).toBeTruthy()

    // No posture/mode was requested, so there is nothing to put in
    // settings.json — it should not exist at all (distinct from existing
    // but empty; the permission-mode write is still conditional on
    // `permissionMode` resolving to something).
    expect(existsSync(`${configDir}/settings.json`)).toBe(false)

    // The isolation file itself: an explicit empty `mcpServers`, not an
    // absent file relying on unspecified SDK fallback behavior. This is
    // the file `@anthropic-ai/claude-agent-sdk` resolves ambient global
    // config (incl. registered MCP servers) from once CLAUDE_CONFIG_DIR is
    // set — confirmed by reading its bundled sdk.mjs directly.
    const globalConfigPath = `${configDir}/.claude.json`
    expect(existsSync(globalConfigPath)).toBe(true)
    expect(JSON.parse(readFileSync(globalConfigPath, "utf8"))).toEqual({
      mcpServers: {},
    })
  })

  it("still isolates CLAUDE_CONFIG_DIR when mode:default is requested explicitly", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "default" } })

    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR
    expect(configDir).toBeTruthy()
    expect(existsSync(`${configDir}/settings.json`)).toBe(false)
    expect(JSON.parse(readFileSync(`${configDir}/.claude.json`, "utf8"))).toEqual({
      mcpServers: {},
    })
  })

  it("does not apply the override for a non-claude-code adapter, even with an identical bin_args_append shape", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "hermes",
      name: "hermes",
    })
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "plan" } })

    // Ambient-config isolation is scoped to `definition.id === "claude-code"`
    // (see `isolateClaudeCodeConfig`): the settings-file mechanism this
    // override writes to is specific to claude-code's ACP wrapper, so a
    // differently-idd adapter (even one that copy-pasted an identical
    // `modes[]` shape) must not get a CLAUDE_CONFIG_DIR override at all.
    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
