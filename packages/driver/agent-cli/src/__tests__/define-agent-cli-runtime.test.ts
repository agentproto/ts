import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { AgentCliClient, AgentCliConnectOptions, AgentCliDefinition } from "../types.js"

// ---------------------------------------------------------------------------
// Mock node:child_process.spawn so `createAgentCliRuntime(...).start()` gets
// a fake ChildProcess with a known pid instead of exec'ing a real binary —
// this is the exact chain that previously discarded the pid (see PLAN.md
// finding #1: "pid: null" traced to define-agent-cli.ts dropping child.pid).
// ---------------------------------------------------------------------------

const FAKE_PID = 54321

function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return {
    pid: FAKE_PID,
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => fakeChild()),
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

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn((armOpts: { requestedMode?: string }) => {
    capturedArmOptions = armOpts
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      async connect(opts) {
        capturedConnectOpts = opts
      },
      async send() {},
      async *events() {},
      async cancel() {},
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
