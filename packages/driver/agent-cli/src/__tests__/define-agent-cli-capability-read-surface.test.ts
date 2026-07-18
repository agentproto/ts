import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type {
  AgentCliClient,
  AgentCliDefinition,
  SessionConfigOption,
  SessionMode,
} from "../types.js"

/**
 * `AgentCliRuntimeSession.setSessionMode` + the capability read-surface
 * (`availableConfigOptions`/`availableModes`/`currentModeId`) — the
 * native-posture counterpart to `setModel`/its own read-surface tests in
 * `define-agent-cli-set-model.test.ts`. Every assertion here would fail on
 * `main`: none of these members exist on the returned session object before
 * this change.
 */

function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return { pid: 1234, stdin, stdout, stderr, killed: false, kill: vi.fn() }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => fakeChild()),
}))

// Mutable per-test fixtures the mocked ACP arm reads from — reset in
// beforeEach so tests don't bleed into each other.
let setSessionModeSpy:
  | ((modeId: string) => Promise<{ applied: boolean; reason?: string }>)
  | undefined
let fakeAvailableConfigOptions: SessionConfigOption[] = []
let fakeAvailableModes: SessionMode[] = []
let fakeCurrentModeId: string | undefined

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => {
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      async connect() {},
      async send() {},
      async *events() {},
      async cancel() {},
      async close() {},
      availableConfigOptions: fakeAvailableConfigOptions,
      availableModes: fakeAvailableModes,
      currentModeId: fakeCurrentModeId,
      ...(setSessionModeSpy ? { setSessionMode: setSessionModeSpy } : {}),
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

describe("AgentCliRuntimeSession — capability read-surface", () => {
  beforeEach(() => {
    setSessionModeSpy = vi.fn(async () => ({ applied: true }))
    fakeAvailableConfigOptions = [
      { type: "select", id: "effort", name: "Effort", options: [], currentValue: "high" },
    ]
    fakeAvailableModes = [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }]
    fakeCurrentModeId = "default"
  })

  it("echoes the arm's captured configOptions/modes/currentModeId onto the session", async () => {
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual(fakeAvailableConfigOptions)
    expect(session.availableModes).toEqual(fakeAvailableModes)
    expect(session.currentModeId).toBe("default")
  })

  it("defaults to empty arrays/undefined for an arm that doesn't populate the read-surface", async () => {
    fakeAvailableConfigOptions = []
    fakeAvailableModes = []
    fakeCurrentModeId = undefined
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual([])
    expect(session.availableModes).toEqual([])
    expect(session.currentModeId).toBeUndefined()
  })
})

describe("AgentCliRuntimeSession.setSessionMode", () => {
  beforeEach(() => {
    setSessionModeSpy = vi.fn(async () => ({ applied: true }))
    fakeAvailableConfigOptions = []
    fakeAvailableModes = []
    fakeCurrentModeId = undefined
  })

  it("delegates to arm.setSessionMode(modeId) and echoes the mode id back on success", async () => {
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    const result = await session.setSessionMode("plan")

    expect(setSessionModeSpy).toHaveBeenCalledWith("plan")
    expect(result).toEqual({ applied: true, modeId: "plan" })
  })

  it("surfaces the arm's rejection reason without throwing", async () => {
    setSessionModeSpy = vi.fn(async () => ({
      applied: false,
      reason: "mode not in availableModes",
    }))
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    await expect(session.setSessionMode("bogus")).resolves.toEqual({
      applied: false,
      reason: "mode not in availableModes",
    })
  })

  it("reports {applied:false, reason:'not-supported'} when the arm has no setSessionMode", async () => {
    setSessionModeSpy = undefined
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    await expect(session.setSessionMode("plan")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
  })

  it("never throws and never kills the session on a rejected switch", async () => {
    setSessionModeSpy = vi.fn(async () => ({ applied: false, reason: "boom" }))
    const runtime = createAgentCliRuntime(baseDef)
    const session = await runtime.start({ cwd: "/tmp" })

    await session.setSessionMode("bogus")
    await expect(session.close()).resolves.toBeUndefined()
  })
})

describe("print-arm — capability read-surface has no live mode surface", () => {
  it("reports empty/undefined read-surface and not-supported setSessionMode", async () => {
    const printDef: AgentCliDefinition = {
      ...baseDef,
      protocol: "print",
      acp: undefined,
    } as AgentCliDefinition

    const runtime = createAgentCliRuntime(printDef)
    const session = await runtime.start({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual([])
    expect(session.availableModes).toEqual([])
    expect(session.currentModeId).toBeUndefined()
    await expect(session.setSessionMode("plan")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
  })
})
