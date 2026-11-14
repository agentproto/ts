import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

// ---------------------------------------------------------------------------
// AcpProtocolArm's capability read-surface (SPEC §3.9/§3.4a): `availableConfig
// Options`/`availableModes`/`currentModeId` must expose whatever the fake ACP
// session captured at connect time, and `setSessionMode` must delegate to the
// live session exactly like `setConfigOption` already does. Mirrors
// acp-client-set-config-option.test.ts's mock-the-client-package approach.
// Every assertion here fails on `main` — none of these members exist on the
// arm returned by `createAcpProtocolArm` before this change.
// ---------------------------------------------------------------------------

const setSessionModeCalls: string[] = []
let setSessionModeResult: { applied: boolean; reason?: string } = { applied: true }
let fakeAvailableConfigOptions: unknown[] = []
let fakeAvailableModes: unknown[] = []
let fakeCurrentModeId: string | undefined

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return {
        sessionId: "sess-1",
        availableConfigOptions: fakeAvailableConfigOptions,
        availableModes: fakeAvailableModes,
        currentModeId: fakeCurrentModeId,
        async setConfigOption() {
          return { applied: true }
        },
        async setSessionMode(modeId: string) {
          setSessionModeCalls.push(modeId)
          return setSessionModeResult
        },
      }
    },
    async loadSession() {
      throw new Error("not used in this test")
    },
  })),
}))

import { createAcpProtocolArm } from "../acp-client.js"

function fakeChild(): ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  } as unknown as ChildProcess
}

const baseConnect = { env: {}, abortSignal: new AbortController().signal }

describe("AcpProtocolArm — capability read-surface getters", () => {
  beforeEach(() => {
    setSessionModeCalls.length = 0
    setSessionModeResult = { applied: true }
    fakeAvailableConfigOptions = [
      { type: "select", id: "model", name: "Model", options: [], currentValue: "sonnet" },
    ]
    fakeAvailableModes = [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }]
    fakeCurrentModeId = "default"
  })

  it("reports empty/undefined before connect() has run", () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    expect(arm.availableConfigOptions).toEqual([])
    expect(arm.availableModes).toEqual([])
    expect(arm.currentModeId).toBeUndefined()
  })

  it("exposes the connected session's captured configOptions/modes/currentModeId", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(arm.availableConfigOptions).toEqual(fakeAvailableConfigOptions)
    expect(arm.availableModes).toEqual(fakeAvailableModes)
    expect(arm.currentModeId).toBe("default")
  })
})

describe("AcpProtocolArm.setSessionMode", () => {
  beforeEach(() => {
    setSessionModeCalls.length = 0
    setSessionModeResult = { applied: true }
    fakeAvailableConfigOptions = []
    fakeAvailableModes = []
    fakeCurrentModeId = undefined
  })

  it("delegates to the live session's setSessionMode once connected", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const result = await arm.setSessionMode!("plan")

    expect(setSessionModeCalls).toEqual(["plan"])
    expect(result).toEqual({ applied: true })
  })

  it("passes through a rejection result verbatim (non-fatal)", async () => {
    setSessionModeResult = { applied: false, reason: "unknown mode: bogus" }
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const result = await arm.setSessionMode!("bogus")
    expect(result).toEqual({ applied: false, reason: "unknown mode: bogus" })
  })

  it("returns {applied:false, reason:'not-connected'} before connect() has run", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const result = await arm.setSessionMode!("plan")
    expect(result).toEqual({ applied: false, reason: "not-connected" })
    expect(setSessionModeCalls).toEqual([])
  })
})
