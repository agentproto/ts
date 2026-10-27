import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

// Capture the args the fake session's own `setConfigOption` receives, so
// the test can prove `AcpProtocolArm.setConfigOption` delegates to the
// LIVE session rather than reaching back into `client.newSession`.
const setConfigOptionCalls: Array<{ configId: string; value: string }> = []
let setConfigOptionResult: { applied: boolean; reason?: string } = { applied: true }

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return {
        sessionId: "sess-1",
        async setConfigOption(configId: string, value: string) {
          setConfigOptionCalls.push({ configId, value })
          return setConfigOptionResult
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

describe("AcpProtocolArm.setConfigOption", () => {
  beforeEach(() => {
    setConfigOptionCalls.length = 0
    setConfigOptionResult = { applied: true }
  })

  it("delegates to the live session's setConfigOption once connected", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const result = await arm.setConfigOption!("model", "opus-5")

    expect(setConfigOptionCalls).toEqual([{ configId: "model", value: "opus-5" }])
    expect(result).toEqual({ applied: true })
  })

  it("passes through a rejection result verbatim (non-fatal)", async () => {
    setConfigOptionResult = { applied: false, reason: "unknown configId" }
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const result = await arm.setConfigOption!("model", "bogus")
    expect(result).toEqual({ applied: false, reason: "unknown configId" })
  })

  it("returns {applied:false, reason:'not-connected'} before connect() has run", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const result = await arm.setConfigOption!("model", "opus-5")
    expect(result).toEqual({ applied: false, reason: "not-connected" })
    expect(setConfigOptionCalls).toEqual([])
  })
})
