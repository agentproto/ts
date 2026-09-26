import { describe, it, expect } from "vitest"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

import { ACP_STEER_METHOD, createAcpClient, isSteeringAdvertised } from "../client/index.js"
import type { StreamEvent } from "../types.js"

// ---------------------------------------------------------------------------
// A real (in-process) ACP agent over the real SDK wire, standing in for
// claude-agent-acp's steering extension: it advertises (or not)
// `InitializeResponse._meta.steering.supported`, holds a prompt open until
// released, and answers `_session/steering` with a scripted outcome.
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-steer"

interface FakeAgent {
  steerCalls: Array<{ method: string; params: Record<string, unknown> }>
  /** What the next `_session/steering` resolves to (or a throw). */
  nextOutcome: string | Error
  releasePrompt(): void
}

function startFakeAgent(opts: { advertise: boolean }) {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent: FakeAgent = { steerCalls: [], nextOutcome: "injected", releasePrompt: () => {} }
  const conn = new AgentSideConnection(
    () => ({
      async initialize() {
        return {
          protocolVersion: 1,
          agentCapabilities: {},
          ...(opts.advertise ? { _meta: { steering: { supported: true }, other: 1 } } : {}),
        } as never
      },
      async newSession() {
        return { sessionId: SESSION_ID }
      },
      async authenticate() {
        return {}
      },
      async prompt() {
        await new Promise<void>(resolve => {
          agent.releasePrompt = resolve
        })
        return { stopReason: "end_turn" }
      },
      async cancel() {},
      async extMethod(method: string, params: Record<string, unknown>) {
        agent.steerCalls.push({ method, params })
        if (agent.nextOutcome instanceof Error) throw agent.nextOutcome
        return { outcome: agent.nextOutcome }
      },
    }),
    ndJsonStream(toClient.writable, toAgent.readable),
  )
  void conn
  return { agent, clientStreams: { output: toAgent.writable, input: toClient.readable } }
}

async function drain(iter: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of iter) void _
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe("createAcpClient — steering", () => {
  it("keeps the top-level initialize _meta and reads steering.supported from it", async () => {
    const { clientStreams } = startFakeAgent({ advertise: true })
    const client = await createAcpClient(clientStreams)
    expect(client.initMeta).toEqual({ steering: { supported: true }, other: 1 })
    expect(client.steeringSupported).toBe(true)
    const session = await client.newSession({ cwd: "/tmp" })
    expect(session.steeringSupported).toBe(true)
  })

  it("steer() during OUR prompt injects via _session/steering with idleBehavior:promptRequired", async () => {
    const { agent, clientStreams } = startFakeAgent({ advertise: true })
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    const turn = drain(session.prompt({ messages: [{ type: "text", text: "work" }] }))
    await tick()
    expect(await session.steer("a child reported: done")).toBe("steered")
    expect(agent.steerCalls).toEqual([
      {
        method: ACP_STEER_METHOD,
        params: {
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "a child reported: done" }],
          _meta: { steering: { idleBehavior: "promptRequired" } },
        },
      },
    ])
    // Block arrays are forwarded verbatim.
    await session.steer([{ type: "text", text: "x" }, { type: "text", text: "y" }])
    expect(agent.steerCalls[1]!.params.prompt).toEqual([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ])
    agent.releasePrompt()
    await turn
  })

  it("maps the agent's promptRequired outcome, and never hits the wire with no host turn in flight", async () => {
    const { agent, clientStreams } = startFakeAgent({ advertise: true })
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    // Idle (no prompt() of ours in flight): refused locally.
    expect(await session.steer("hi")).toBe("promptRequired")
    expect(agent.steerCalls).toEqual([])
    // In flight but the agent says its turn already settled (race).
    const turn = drain(session.prompt({ messages: [{ type: "text", text: "work" }] }))
    await tick()
    agent.nextOutcome = "promptRequired"
    expect(await session.steer("hi")).toBe("promptRequired")
    agent.releasePrompt()
    await turn
  })

  it("unsupported: not advertised ⇒ nothing sent; a rejection or unknown outcome ⇒ unsupported", async () => {
    const off = startFakeAgent({ advertise: false })
    const c1 = await createAcpClient(off.clientStreams)
    expect(c1.steeringSupported).toBe(false)
    expect(c1.initMeta).toBeUndefined()
    const s1 = await c1.newSession({ cwd: "/tmp" })
    const t1 = drain(s1.prompt({ messages: [{ type: "text", text: "w" }] }))
    await tick()
    expect(await s1.steer("hi")).toBe("unsupported")
    expect(off.agent.steerCalls).toEqual([])
    off.agent.releasePrompt()
    await t1

    const on = startFakeAgent({ advertise: true })
    const c2 = await createAcpClient(on.clientStreams)
    const s2 = await c2.newSession({ cwd: "/tmp" })
    const t2 = drain(s2.prompt({ messages: [{ type: "text", text: "w" }] }))
    await tick()
    on.agent.nextOutcome = new Error("boom")
    expect(await s2.steer("hi")).toBe("unsupported")
    on.agent.nextOutcome = "somethingNew"
    expect(await s2.steer("hi")).toBe("unsupported")
    // A wrapper that ignored the opt-in and started a turn DID deliver it.
    on.agent.nextOutcome = "startedNewTurn"
    expect(await s2.steer("hi")).toBe("steered")
    on.agent.releasePrompt()
    await t2
  })
})

describe("isSteeringAdvertised", () => {
  it("requires steering.supported === true", () => {
    expect(isSteeringAdvertised({ steering: { supported: true } })).toBe(true)
    expect(isSteeringAdvertised({ steering: { supported: "yes" } })).toBe(false)
    expect(isSteeringAdvertised({ steering: true })).toBe(false)
    expect(isSteeringAdvertised(undefined)).toBe(false)
  })
})
