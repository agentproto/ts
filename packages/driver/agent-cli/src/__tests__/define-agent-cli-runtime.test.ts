import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import type { AgentCliClient, AgentCliConnectOptions, AgentCliDefinition } from "../types.js"

// ---------------------------------------------------------------------------
// Mock node:child_process.spawn so `createAgentCliRuntime(...).start()` gets
// a fake ChildProcess with a known pid instead of exec'ing a real binary —
// this is the exact chain that previously discarded the pid (see PLAN.md
// finding #1: "pid: null" traced to define-agent-cli.ts dropping child.pid).
// ---------------------------------------------------------------------------

const FAKE_PID = 54321
let capturedSandboxOpts: { extraReadPaths?: string[]; extraWritePaths?: string[] } | undefined

// A real EventEmitter (not a plain object) so `spawned.once("spawn"|"error", ...)`
// in define-agent-cli.ts's spawn guard works — emits "spawn" on the next
// microtask, mirroring a real ChildProcess's async success signal.
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: FAKE_PID,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  })
  queueMicrotask(() => child.emit("spawn"))
  return child
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => fakeChild()),
}))

vi.mock("../command-sandbox-wrap.js", () => ({
  wrapAgentCliSpawn: vi.fn(async (bin: string, args: string[], opts: typeof capturedSandboxOpts) => {
    capturedSandboxOpts = opts
    return [bin, args]
  }),
}))

// Mock the ACP protocol arm so connect()/send() are fully controlled —
// captures the options `connect()` receives so the test can assert
// `onActivity` was forwarded from `start()`'s options.
let capturedConnectOpts: AgentCliConnectOptions | undefined
// Captures the options `createAcpProtocolArm(...)` itself was constructed
// with, so a test can assert `requestedMode` was threaded from
// `start()`'s `config.mode` down to the arm (see the plan-mode auto-allow
// fix: the arm picks its default permission handler off this field).
let capturedArmOptions: { requestedMode?: string } | undefined
// Turn ids the arm's OWN cancel() was called with. `session.cancel()` used to
// abort a connection-level AbortController no arm reads, so the arm's real
// cancel — the one that sends ACP `session/cancel` / SIGTERMs the child —
// never fired and nothing here recorded a thing.
let armCancelCalls: string[] = []
// Turn ids handed to the arm's send(), so a test can assert cancel() names the
// turn actually in flight rather than some other id.
let armSendTurnIds: string[] = []

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn((armOpts: { requestedMode?: string }) => {
    capturedArmOptions = armOpts
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      async connect(opts) {
        capturedConnectOpts = opts
      },
      async send(turnId) {
        armSendTurnIds.push(turnId)
      },
      async *events() {},
      async cancel(turnId) {
        armCancelCalls.push(turnId)
      },
      async close() {},
    }
    return arm
  }),
}))

import { createAgentCliRuntime } from "../define-agent-cli.js"

const minimalDef: AgentCliDefinition = {
  name: "hermes",
  id: "hermes",
  description: "fake",
  version: "0.1.0",
  bin: "hermes",
  bin_args: ["acp"],
  install: [{ method: "brew", package: "hermes" }],
  version_check: {
    cmd: "hermes --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.13.0",
    timeout_ms: 5000,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./hermes-acp.ACP.md",
} as AgentCliDefinition

describe("createAgentCliRuntime(...).start() — pid + onActivity threading", () => {
  beforeEach(() => {
    capturedConnectOpts = undefined
    capturedSandboxOpts = undefined
  })

  it("mirrors the spawned child's pid onto the returned runtime session", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const session = await runtime.start({ cwd: "/tmp" })
    expect(session.pid).toBe(FAKE_PID)
  })

  it("forwards start()'s onActivity through to protocolArm.connect()", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const onActivity = vi.fn()
    await runtime.start({ cwd: "/tmp", onActivity })
    expect(capturedConnectOpts?.onActivity).toBe(onActivity)
  })

  it("omits onActivity from connect() when start() wasn't given one", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    await runtime.start({ cwd: "/tmp" })
    expect(capturedConnectOpts?.onActivity).toBeUndefined()
  })

  it("threads daemon-authored exact read paths to the child and confinement without widening writes", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const additionalReadPaths = ["/repo/AGENTS.md"]
    await runtime.start({ cwd: "/repo/apps/child", additionalReadPaths })

    const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
      | { env?: Record<string, string> }
      | undefined
    expect(spawnOpts?.env?.AGENTPROTO_ADDITIONAL_READ_PATHS).toBe(
      JSON.stringify(additionalReadPaths),
    )
    expect(capturedSandboxOpts?.extraReadPaths).toEqual(additionalReadPaths)
    expect(capturedSandboxOpts?.extraWritePaths).toBeUndefined()
  })
})

// `session.cancel()` is what the host's whole interrupt path bottoms out in
// (SessionsRegistry.interruptSession, `{interrupt: true}`, the VS Code Stop
// button). It used to call `abortController.abort()` and nothing else — but
// that controller is the CONNECTION-level signal passed to arm.connect(), and
// no arm reads it. So cancel() aborted into the void: the agent kept working,
// and the host's 60s settle-wait timed out on a turn nobody had asked to stop.
// Both arms already implemented the real cancel (ACP `session/cancel`; SIGTERM
// for the print arm) — it was simply never called. These pin the call through.
describe("createAgentCliRuntime(...) — session.cancel() reaches the arm", () => {
  beforeEach(() => {
    armCancelCalls = []
    armSendTurnIds = []
  })

  it("delegates cancel() to the protocol arm's own cancel", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const session = await runtime.start({ cwd: "/tmp" })
    session.send("hello")
    await session.cancel()
    expect(armCancelCalls).toHaveLength(1)
  })

  it("cancels the turn actually in flight, not a stale or invented one", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const session = await runtime.start({ cwd: "/tmp" })
    // Drained, not just called: send() returns a LAZY async iterable, so the
    // arm's own send() (and the turn id it records) only fires once someone
    // iterates it. The mocked arm yields no events, so each drains at once.
    for await (const _evt of session.send("first")) void _evt
    for await (const _evt of session.send("second")) void _evt
    await session.cancel()
    // The id must be the LATEST turn's — cancelling the first turn while the
    // second is running would leave the live turn untouched.
    expect(armSendTurnIds).toHaveLength(2)
    expect(armCancelCalls).toEqual([armSendTurnIds[1]])
  })

  it("is a no-op when no turn has ever been sent", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    const session = await runtime.start({ cwd: "/tmp" })
    await session.cancel()
    // Naming a turn that never existed would be a lie to the arm; the ACP arm
    // would happily forward a `session/cancel` for nothing.
    expect(armCancelCalls).toEqual([])
  })
})

describe("createAgentCliRuntime(...).start() — mode env_unset scrub", () => {
  // A gateway mode must scrub the real ANTHROPIC_API_KEY so it can't leak
  // to a third-party Anthropic-compatible host. The scrub happens at the
  // env-merge point in start(), AFTER ambient process.env is folded in but
  // BEFORE operator-supplied opts.env (operator intent wins).
  const gatewayDef: AgentCliDefinition = {
    ...minimalDef,
    modes: [
      {
        id: "gateway",
        env: { ANTHROPIC_BASE_URL: "https://gw.example/anthropic" },
        env_unset: ["ANTHROPIC_API_KEY"],
      },
    ],
  } as AgentCliDefinition

  beforeEach(() => {
    capturedConnectOpts = undefined
  })

  it("deletes ambient env keys declared by the active mode's env_unset", async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "real-secret-must-not-leak"
    try {
      const runtime = createAgentCliRuntime(gatewayDef)
      await runtime.start({ cwd: "/tmp", config: { mode: "gateway" } })
      const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOpts?.env?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnOpts?.env?.ANTHROPIC_BASE_URL).toBe(
        "https://gw.example/anthropic"
      )
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  it("lets operator-supplied opts.env survive the scrub (operator intent wins)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "ambient-secret"
    try {
      const runtime = createAgentCliRuntime(gatewayDef)
      await runtime.start({
        cwd: "/tmp",
        config: { mode: "gateway" },
        env: { ANTHROPIC_API_KEY: "operator-forwarded" },
      })
      const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOpts?.env?.ANTHROPIC_API_KEY).toBe("operator-forwarded")
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })
})

describe("createAgentCliRuntime(...).start() — option env_unset scrub", () => {
  // A value-bearing option (e.g. base_url) carrying env_unset must scrub the
  // ambient credential the moment it's set — same merge point as mode
  // env_unset, so a bare base_url auto-scrubs ANTHROPIC_API_KEY without the
  // operator having to also pick a preset mode.
  const baseUrlDef: AgentCliDefinition = {
    ...minimalDef,
    options: [
      {
        id: "base_url",
        type: "string",
        env: { ANTHROPIC_BASE_URL: "{value}" },
        env_unset: ["ANTHROPIC_API_KEY"],
      },
    ],
  } as AgentCliDefinition

  beforeEach(() => {
    capturedConnectOpts = undefined
  })

  it("deletes ambient env keys declared by the active option's env_unset", async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "real-secret-must-not-leak"
    try {
      const runtime = createAgentCliRuntime(baseUrlDef)
      await runtime.start({
        cwd: "/tmp",
        config: { options: { base_url: "https://gw.example/anthropic" } },
      })
      const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOpts?.env?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnOpts?.env?.ANTHROPIC_BASE_URL).toBe(
        "https://gw.example/anthropic"
      )
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  it("does NOT scrub when the option is absent (no scrub without an active value)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "should-stay"
    try {
      const runtime = createAgentCliRuntime(baseUrlDef)
      await runtime.start({ cwd: "/tmp" })
      const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOpts?.env?.ANTHROPIC_API_KEY).toBe("should-stay")
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })
})

describe("createAgentCliRuntime(...).start() — turnIdleTimeoutMs threading", () => {
  beforeEach(() => {
    capturedConnectOpts = undefined
  })

  it("forwards start()'s turnIdleTimeoutMs through to protocolArm.connect()", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    await runtime.start({ cwd: "/tmp", turnIdleTimeoutMs: 45_000 })
    expect(capturedConnectOpts?.turnIdleTimeoutMs).toBe(45_000)
  })

  it("omits turnIdleTimeoutMs from connect() when neither start() nor the manifest declare one", async () => {
    const runtime = createAgentCliRuntime(minimalDef)
    await runtime.start({ cwd: "/tmp" })
    expect(capturedConnectOpts?.turnIdleTimeoutMs).toBeUndefined()
  })

  it("falls back to the manifest's session.turn_idle_timeout_ms when start() doesn't override it", async () => {
    const defWithManifestDefault: AgentCliDefinition = {
      ...minimalDef,
      session: { turn_idle_timeout_ms: 300_000 },
    } as AgentCliDefinition
    const runtime = createAgentCliRuntime(defWithManifestDefault)
    await runtime.start({ cwd: "/tmp" })
    expect(capturedConnectOpts?.turnIdleTimeoutMs).toBe(300_000)
  })

  it("lets a caller-supplied turnIdleTimeoutMs override the manifest default", async () => {
    const defWithManifestDefault: AgentCliDefinition = {
      ...minimalDef,
      session: { turn_idle_timeout_ms: 300_000 },
    } as AgentCliDefinition
    const runtime = createAgentCliRuntime(defWithManifestDefault)
    await runtime.start({ cwd: "/tmp", turnIdleTimeoutMs: 10_000 })
    expect(capturedConnectOpts?.turnIdleTimeoutMs).toBe(10_000)
  })
})

describe("createAgentCliRuntime(...).start() — requestedMode threading", () => {
  const defWithModes: AgentCliDefinition = {
    ...minimalDef,
    modes: [
      { id: "default", description: "Standard." },
      { id: "plan", description: "Plan-only.", bin_args_append: ["--permission-mode", "plan"] },
    ],
  } as AgentCliDefinition

  beforeEach(() => {
    capturedArmOptions = undefined
  })

  it("forwards config.mode as requestedMode so the ACP arm can pick the plan-mode-aware permission handler", async () => {
    const runtime = createAgentCliRuntime(defWithModes)
    await runtime.start({ cwd: "/tmp", config: { mode: "plan" } })
    expect(capturedArmOptions?.requestedMode).toBe("plan")
  })

  it("omits requestedMode when start() doesn't set config.mode — default-mode sessions are unaffected", async () => {
    const runtime = createAgentCliRuntime(defWithModes)
    await runtime.start({ cwd: "/tmp" })
    expect(capturedArmOptions?.requestedMode).toBeUndefined()
  })
})

describe("createAgentCliRuntime(...).start() — apply:'config' mode threading (opencode-style)", () => {
  const defWithConfigMode: AgentCliDefinition = {
    ...minimalDef,
    modes: [
      { id: "default", description: "Standard." },
      { id: "plan", description: "Plan-only.", apply: "config" },
      {
        id: "build",
        description: "Auto-execute.",
        bin_args_append: ["--legacy-build-flag"],
      },
    ],
  } as AgentCliDefinition

  beforeEach(() => {
    capturedConnectOpts = undefined
  })

  it("passes mode to connect() when the requested mode declares apply:'config'", async () => {
    const runtime = createAgentCliRuntime(defWithConfigMode)
    await runtime.start({ cwd: "/tmp", config: { mode: "plan" } })
    expect(capturedConnectOpts?.mode).toBe("plan")
  })

  it("omits mode from connect() for a mode without apply:'config' (default 'bin_args')", async () => {
    const runtime = createAgentCliRuntime(defWithConfigMode)
    await runtime.start({ cwd: "/tmp", config: { mode: "build" } })
    expect(capturedConnectOpts?.mode).toBeUndefined()
  })

  it("omits mode from connect() when no mode is requested", async () => {
    const runtime = createAgentCliRuntime(defWithConfigMode)
    await runtime.start({ cwd: "/tmp" })
    expect(capturedConnectOpts?.mode).toBeUndefined()
  })
})
