import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

// Capture the args every `client.newSession` / `client.loadSession` call
// receives, so the test can prove the host's `mcpServers` survives the
// hop through AcpProtocolArm.connect → @agentproto/acp client.
const newSessionCalls: Array<Record<string, unknown>> = []
const loadSessionCalls: Array<Record<string, unknown>> = []

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession(params: Record<string, unknown>) {
      newSessionCalls.push(params)
      return { sessionId: "sess-1" }
    },
    async loadSession(params: Record<string, unknown>) {
      loadSessionCalls.push(params)
      return { sessionId: params.sessionId }
    },
  })),
}))

import { createAcpProtocolArm } from "../acp-client.js"

/** A minimal ChildProcess stand-in with piped stdio the arm can wrap. */
function fakeChild(): ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  } as unknown as ChildProcess
}

/** The two always-present connect fields the runner fills in before the
 *  arm sees them — irrelevant to mcpServers threading, so stubbed. */
const baseConnect = { env: {}, abortSignal: new AbortController().signal }

describe("AcpProtocolArm.connect — mcpServers threading", () => {
  beforeEach(() => {
    newSessionCalls.length = 0
    loadSessionCalls.length = 0
  })

  it("forwards host mcpServers to client.newSession on a fresh session", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const mcpServers = [
      { name: "orchestrator", transport: "stdio" as const, ref: "./O.md" },
    ]
    await arm.connect({ ...baseConnect, cwd: "/work", mcpServers })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toEqual({ cwd: "/work", mcpServers })
  })

  it("forwards host mcpServers to client.loadSession on resume", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const mcpServers = [{ name: "gw", transport: "http" as const }]
    await arm.connect({
      ...baseConnect,
      cwd: "/work",
      resumeSessionId: "prev-123",
      mcpServers,
    })

    expect(loadSessionCalls).toHaveLength(1)
    expect(loadSessionCalls[0]).toEqual({
      sessionId: "prev-123",
      cwd: "/work",
      mcpServers,
    })
  })

  it("omits mcpServers when the host provides none", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toEqual({ cwd: "/work", mcpServers: undefined })
  })
})
