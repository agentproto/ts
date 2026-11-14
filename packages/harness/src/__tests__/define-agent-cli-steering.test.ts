import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import type { AgentCliClient, AgentCliDefinition, SteerOutcome } from "../types.js"

/**
 * `AgentCliRuntimeSession.steer` / `steeringSupported` — passthrough of the
 * protocol arm's ACP steering (`@agentproto/acp/client`'s
 * `AcpClientSession.steer`). Absent entirely for an arm with no `steer`.
 */

// A real EventEmitter (not a plain object) so `spawned.once("spawn"|"error", ...)`
// in define-agent-cli.ts's spawn guard works — emits "spawn" on the next
// microtask, mirroring a real ChildProcess's async success signal.
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
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

// Per-test arm shape.
let armSteer: ((content: unknown) => Promise<SteerOutcome>) | undefined
let armSteeringSupported: boolean | undefined

vi.mock("../protocol/acp-client.js", () => ({
  createAcpProtocolArm: vi.fn(() => {
    const arm: AgentCliClient = {
      sessionId: "acp-sess-1",
      async connect() {},
      async send() {},
      async *events() {},
      async cancel() {},
      async close() {},
      ...(armSteer ? { steer: armSteer } : {}),
      ...(armSteeringSupported !== undefined ? { steeringSupported: armSteeringSupported } : {}),
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

describe("AgentCliRuntimeSession — steering passthrough", () => {
  beforeEach(() => {
    armSteer = undefined
    armSteeringSupported = undefined
  })

  it("exposes steer + steeringSupported and delegates to the arm", async () => {
    armSteer = vi.fn(async () => "steered" as const)
    armSteeringSupported = true
    const session = await createAgentCliRuntime(baseDef).start({ cwd: "/tmp" })
    expect(session.steeringSupported).toBe(true)
    expect(await session.steer!("hello")).toBe("steered")
    expect(armSteer).toHaveBeenCalledWith("hello")
  })

  it("reports steeringSupported:false when the arm can steer but the agent didn't advertise it", async () => {
    armSteer = vi.fn(async () => "unsupported" as const)
    armSteeringSupported = false
    const session = await createAgentCliRuntime(baseDef).start({ cwd: "/tmp" })
    expect(session.steeringSupported).toBe(false)
    expect(await session.steer!("x")).toBe("unsupported")
  })

  it("omits both for an arm without steer", async () => {
    const session = await createAgentCliRuntime(baseDef).start({ cwd: "/tmp" })
    expect(session.steer).toBeUndefined()
    expect(session.steeringSupported).toBeUndefined()
  })
})
