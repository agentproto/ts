import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import { spawn } from "node:child_process"
import type {
  AgentCliClient,
  AgentCliDefinition,
  ResolvedAuthSpec,
  StreamEvent,
} from "../types.js"

/**
 * `AgentCliRuntimeSession.setModel` — the mid-session counterpart to the
 * spawn-time `models.apply` handling in `define-agent-cli.ts`. Each
 * strategy must dispatch differently:
 *   - "config"  → `arm.setConfigOption("model", id)` on the retained arm.
 *   - "command" → the same `/model <id>` control-turn mechanism
 *     `applyModelCommand` already uses at spawn time.
 *   - "arg"     → always `{applied:false, reason:"requires-restart"}`,
 *     with NO interaction with the arm at all (there's nothing to call —
 *     the model is baked into argv at spawn).
 *
 * Every assertion here would fail on `main`: `setModel` doesn't exist on
 * the returned session object at all before this change.
 */

function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return { pid: 1234, stdin, stdout, stderr, killed: false, kill: vi.fn() }
}

const spawnCalls: Array<{ bin: string; args: string[] }> = []

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    return fakeChild()
  }),
}))

// Mutable per-test fixtures the mocked ACP arm reads from — reset in
// beforeEach so tests don't bleed into each other.
let setConfigOptionSpy:
  | ((configId: string, value: string) => Promise<{ applied: boolean; reason?: string }>)
  | undefined
let sendCalls: Array<{ turnId: string; message: unknown }> = []
let scriptedEvents: StreamEvent[] = []
let sendError: Error | undefined

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => {
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      async connect() {},
      async send(turnId, message) {
        sendCalls.push({ turnId, message })
        if (sendError) throw sendError
      },
      async *events() {
        for (const e of scriptedEvents) yield e
      },
      async cancel() {},
      async close() {},
      ...(setConfigOptionSpy ? { setConfigOption: setConfigOptionSpy } : {}),
    }
    return arm
  }),
}))

import { createAgentCliRuntime } from "../define-agent-cli.js"

const baseDef: AgentCliDefinition = {
  name: "fake",
  id: "fake",
  description: "fake",
  version: "0.1.0",
  bin: "fake",
  bin_args: ["acp"],
  install: [{ method: "brew", package: "fake" }],
  version_check: {
    cmd: "fake --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 5000,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./fake-acp.ACP.md",
} as AgentCliDefinition

describe("AgentCliRuntimeSession.setModel — apply:'config' (default)", () => {
  beforeEach(() => {
    sendCalls = []
    scriptedEvents = []
    setConfigOptionSpy = vi.fn(async () => ({ applied: true }))
  })

  it("delegates to arm.setConfigOption('model', id) and echoes the model back on success", async () => {
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    const result = await session.setModel("claude-sonnet-5")

    expect(setConfigOptionSpy).toHaveBeenCalledWith("model", "claude-sonnet-5")
    expect(result).toEqual({ applied: true, model: "claude-sonnet-5" })
    // Never falls back to a control turn for the config strategy.
    expect(sendCalls).toEqual([])
  })

  it("surfaces the arm's rejection reason without throwing", async () => {
    setConfigOptionSpy = vi.fn(async () => ({
      applied: false,
      reason: "Invalid value for config option model: bogus",
    }))
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    await expect(session.setModel("bogus")).resolves.toEqual({
      applied: false,
      reason: "Invalid value for config option model: bogus",
    })
  })

  it("reports {applied:false, reason:'not-supported'} when the arm has no setConfigOption", async () => {
    setConfigOptionSpy = undefined
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    await expect(session.setModel("claude-sonnet-5")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
  })
})

describe("AgentCliRuntimeSession.setModel — apply:'command' (hermes-style)", () => {
  const commandDef: AgentCliDefinition = {
    ...baseDef,
    models: { apply: "command" },
  } as AgentCliDefinition

  beforeEach(() => {
    sendCalls = []
    scriptedEvents = []
    setConfigOptionSpy = undefined
    sendError = undefined
  })

  it("sends a drained '/model <id>' control turn and reports applied:true on an acknowledgement", async () => {
    scriptedEvents = [
      { kind: "text-delta", sessionId: "acp-sess-1", text: "Model switched to: opus-5 · Provider: anthropic" },
      { kind: "turn-end", sessionId: "acp-sess-1", reason: "completed" },
    ]
    const runtime = createAgentCliRuntime(commandDef)
    const session = await runtime.start({ cwd: "/tmp" })
    sendCalls = [] // ignore any spawn-time control turn noise (none expected here — no models.default)

    const result = await session.setModel("opus-5")

    expect(result).toEqual({ applied: true, model: "opus-5" })
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]?.message).toEqual({ type: "text", text: "/model opus-5" })
  })

  it("reports applied:false when the agent never acknowledges the switch", async () => {
    scriptedEvents = [{ kind: "turn-end", sessionId: "acp-sess-1", reason: "completed" }]
    const runtime = createAgentCliRuntime(commandDef)
    const session = await runtime.start({ cwd: "/tmp" })

    const result = await session.setModel("opus-5")
    expect(result.applied).toBe(false)
    expect(result.reason).toMatch(/no switch acknowledgement/i)
  })

  it("reports applied:false with the error message when the control turn itself throws, and never kills the session", async () => {
    const runtime = createAgentCliRuntime(commandDef)
    const session = await runtime.start({ cwd: "/tmp" })

    sendError = new Error("adapter disconnected")
    const result = await session.setModel("opus-5")

    expect(result).toEqual({ applied: false, reason: "adapter disconnected" })
    // The session itself is unaffected by a failed switch — still closeable,
    // and a subsequent send (past the throw) still reaches the arm.
    sendError = undefined
    await expect(session.close()).resolves.toBeUndefined()
  })
})

describe("AgentCliRuntimeSession.setModel — apply:'arg' (codex-style)", () => {
  const argDef: AgentCliDefinition = {
    ...baseDef,
    models: { apply: "arg", bin_args_template: ["-c", "model={model}"] },
  } as AgentCliDefinition

  beforeEach(() => {
    sendCalls = []
    scriptedEvents = []
    setConfigOptionSpy = vi.fn(async () => ({ applied: true }))
  })

  it("always reports {applied:false, reason:'requires-restart'} without touching the arm at all", async () => {
    const runtime = createAgentCliRuntime(argDef)
    const session = await runtime.start({ cwd: "/tmp" })

    const result = await session.setModel("o4-mini")

    expect(result).toEqual({ applied: false, reason: "requires-restart" })
    expect(sendCalls).toEqual([])
    expect(setConfigOptionSpy).not.toHaveBeenCalled()
  })
})

describe("AgentCliRuntime.start — codex model argv auth awareness", () => {
  const codexDef: AgentCliDefinition = {
    ...baseDef,
    id: "codex",
    name: "codex",
    provider: "openai",
    options: [
      {
        id: "model",
        type: "enum",
        enum: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-pro"],
      },
    ],
    models: {
      default: "gpt-5-codex",
      allowed: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-pro"],
      apply: "arg",
      bin_args_template: ["-c", 'model="{model}"'],
    },
  } as AgentCliDefinition

  beforeEach(() => {
    spawnCalls.length = 0
    setConfigOptionSpy = undefined
    scriptedEvents = []
    sendError = undefined
  })

  it("keeps the model argv when api-key auth is present", async () => {
    const prevHome = process.env.HOME
    const prevKey = process.env.OPENAI_API_KEY
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.HOME = "/tmp/codex-auth-test-home"
    process.env.OPENAI_API_KEY = "sk-proj-auth-key"
    try {
      const runtime = createAgentCliRuntime(codexDef)
      await runtime.start({
        cwd: "/tmp",
        config: { options: { model: "gpt-5" } },
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    }

    expect(spawnCalls[0]!.args).toEqual([
      "acp",
      "-c",
      'model="gpt-5"',
    ])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("skips the model argv and warns when no api key is available", async () => {
    const prevHome = process.env.HOME
    const prevKey = process.env.OPENAI_API_KEY
    const prevCodexKey = process.env.CODEX_API_KEY
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.HOME = "/tmp/codex-auth-test-home"
    delete process.env.OPENAI_API_KEY
    delete process.env.CODEX_API_KEY
    try {
      const runtime = createAgentCliRuntime(codexDef)
      await runtime.start({
        cwd: "/tmp",
        config: { options: { model: "gpt-5" } },
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
      if (prevCodexKey === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = prevCodexKey
    }

    expect(spawnCalls[0]!.args).toEqual(["acp"])
    expect(warnSpy).toHaveBeenCalledWith(
      '[agent-cli] codex: skipped model override "gpt-5" for ChatGPT-account auth; using Codex\'s default model.',
    )
    warnSpy.mockRestore()
  })

  // Regression: `resolveCliEnv`'s narrower PROVIDER_KEY_ENV allowlist doesn't
  // forward CODEX_API_KEY (it's tuned for `makeAgentCliModel`), so detection
  // must be built from the real ambient env, not that helper — otherwise a
  // codex user with ONLY CODEX_API_KEY set ambiently (no OPENAI_API_KEY)
  // would be misdetected as ChatGPT-account auth and lose their model
  // override, even though the spawned process itself inherits the key fine.
  it("keeps the model argv when only ambient CODEX_API_KEY (no OPENAI_API_KEY) is present", async () => {
    const prevHome = process.env.HOME
    const prevKey = process.env.OPENAI_API_KEY
    const prevCodexKey = process.env.CODEX_API_KEY
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.HOME = "/tmp/codex-auth-test-home"
    delete process.env.OPENAI_API_KEY
    process.env.CODEX_API_KEY = "sk-codex-ambient-key"
    try {
      const runtime = createAgentCliRuntime(codexDef)
      await runtime.start({
        cwd: "/tmp",
        config: { options: { model: "gpt-5" } },
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
      if (prevCodexKey === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = prevCodexKey
    }

    expect(spawnCalls[0]!.args).toEqual(["acp", "-c", 'model="gpt-5"'])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // Regression: a deterministic billing-auth credential resolved via
  // `opts.auth` (the config-store/`agentproto auth provider set` flow) must
  // be authoritative over ambient-env/auth.json sniffing — an operator who
  // configured an api-key this way (never exported to the shell, per
  // `ResolvedAuthSpec`'s own contract) must not have their model override
  // silently dropped just because no ambient env var / auth.json says
  // "api-key".
  it("keeps the model argv when opts.auth resolves an explicit, credentialed api-key spec — no ambient env at all", async () => {
    const prevHome = process.env.HOME
    const prevKey = process.env.OPENAI_API_KEY
    const prevCodexKey = process.env.CODEX_API_KEY
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.HOME = "/tmp/codex-auth-test-home"
    delete process.env.OPENAI_API_KEY
    delete process.env.CODEX_API_KEY
    const authSpec: ResolvedAuthSpec = {
      mode: "api-key",
      credential: "sk-configured-from-store",
      setEnv: "OPENAI_API_KEY",
      unsetEnv: [],
      explicit: true,
      enforce: "when-configured",
    }
    try {
      const runtime = createAgentCliRuntime(codexDef)
      await runtime.start({
        cwd: "/tmp",
        config: { options: { model: "gpt-5" } },
        auth: authSpec,
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
      if (prevCodexKey === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = prevCodexKey
    }

    expect(spawnCalls[0]!.args).toEqual(["acp", "-c", 'model="gpt-5"'])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
