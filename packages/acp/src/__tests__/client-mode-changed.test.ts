import { describe, it, expect } from "vitest"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

import { createAcpClient } from "../client/index.js"
import type { StreamEvent } from "../types.js"

// ---------------------------------------------------------------------------
// A real (in-process) ACP agent over the real SDK wire. It advertises two
// modes, switches mode by itself during a turn, and answers
// `session/set_mode` either with a `current_mode_update` echo before the
// response or with no echo at all (both happen in the wild).
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-modes"

interface FakeAgent {
  echoSetMode: boolean
  /** Mode updates the agent sends during its next prompt. */
  promptModes: string[]
  sendModeUpdate(modeId: string): Promise<void>
}

function startFakeAgent(): {
  agent: FakeAgent
  clientStreams: { output: WritableStream<Uint8Array>; input: ReadableStream<Uint8Array> }
} {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent: FakeAgent = { echoSetMode: true, promptModes: [], sendModeUpdate: async () => {} }
  const conn = new AgentSideConnection(
    client => {
      agent.sendModeUpdate = (modeId: string) =>
        client.sessionUpdate({
          sessionId: SESSION_ID,
          update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
        })
      return {
        async initialize() {
          return { protocolVersion: 1, agentCapabilities: {} }
        },
        async newSession() {
          return {
            sessionId: SESSION_ID,
            modes: {
              currentModeId: "default",
              availableModes: [
                { id: "default", name: "Default" },
                { id: "plan", name: "Plan" },
              ],
            },
          }
        },
        async setSessionMode(params) {
          if (agent.echoSetMode) await agent.sendModeUpdate(params.modeId)
          return {}
        },
        async authenticate() {
          return {}
        },
        async prompt() {
          for (const modeId of agent.promptModes) await agent.sendModeUpdate(modeId)
          return { stopReason: "end_turn" }
        },
        async cancel() {},
      }
    },
    ndJsonStream(toClient.writable, toAgent.readable),
  )
  void conn
  return { agent, clientStreams: { output: toAgent.writable, input: toClient.readable } }
}

async function drain(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const evt of iter) out.push(evt)
  return out
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe("createAcpClient: current_mode_update to mode-changed", () => {
  it("reports an agent's own switch with cause agent and the tracked previous mode", async () => {
    const { agent, clientStreams } = startFakeAgent()
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    agent.promptModes = ["plan", "plan"]
    const events = await drain(session.prompt({ messages: [{ type: "text", text: "go" }] }))
    // The repeated update is a no-op and is not reported.
    expect(events.filter(e => e.kind === "mode-changed")).toEqual([
      { kind: "mode-changed", sessionId: SESSION_ID, modeId: "plan", previousModeId: "default", cause: "agent" },
    ])
  })

  it("reports the caller's setSessionMode once, cause caller, when the agent echoes it", async () => {
    const { clientStreams } = startFakeAgent()
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    const outOfTurn: StreamEvent[] = []
    session.onOutOfTurnEvent(evt => outOfTurn.push(evt))
    expect(await session.setSessionMode("plan")).toEqual({ applied: true })
    await tick()
    expect(outOfTurn).toEqual([
      { kind: "mode-changed", sessionId: SESSION_ID, modeId: "plan", previousModeId: "default", cause: "caller" },
    ])
  })

  it("reports the caller's setSessionMode when the agent sends no echo, and a late agent switch as agent", async () => {
    const { agent, clientStreams } = startFakeAgent()
    agent.echoSetMode = false
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    const outOfTurn: StreamEvent[] = []
    session.onOutOfTurnEvent(evt => outOfTurn.push(evt))
    await session.setSessionMode("plan")
    await agent.sendModeUpdate("plan") // late echo: already current, a no-op
    await agent.sendModeUpdate("default")
    await tick()
    expect(outOfTurn).toEqual([
      { kind: "mode-changed", sessionId: SESSION_ID, modeId: "plan", previousModeId: "default", cause: "caller" },
      { kind: "mode-changed", sessionId: SESSION_ID, modeId: "default", previousModeId: "plan", cause: "agent" },
    ])
  })
})
