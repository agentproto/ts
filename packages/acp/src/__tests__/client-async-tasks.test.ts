import { describe, it, expect } from "vitest"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

import { createAcpClient } from "../client/index.js"
import type { StreamEvent } from "../types.js"

// ---------------------------------------------------------------------------
// A real (in-process) ACP agent over the real SDK wire, standing in for
// claude-agent-acp's background-task behaviour: when the client advertises
// the AIR `asyncTasks` extension it publishes the task lifecycle
// (`async_task_spawned` → `async_task_state_update`), and when the task
// settles AFTER the prompt already resolved it runs an autonomous
// task-notification cycle — text, then a cost-bearing usage_update tagged
// `_claude/origin: task-notification` — with no `session/prompt` in flight.
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-bg"

interface FakeAgent {
  initParams?: Record<string, unknown>
  /** Fire the post-turn lifecycle: the task settles, the agent wakes itself. */
  settleAndWake(): Promise<void>
}

function advertisesAsyncTasks(params: Record<string, unknown> | undefined): boolean {
  const caps = params?.clientCapabilities as { _meta?: Record<string, unknown> } | undefined
  const air = (caps?._meta?.jetbrains as { air?: { version?: unknown; capabilities?: unknown } })?.air
  return (
    typeof air?.version === "number" &&
    air.version >= 1 &&
    Array.isArray(air.capabilities) &&
    air.capabilities.includes("asyncTasks")
  )
}

function startFakeAgent(): { agent: FakeAgent; clientStreams: { output: WritableStream<Uint8Array>; input: ReadableStream<Uint8Array> } } {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent: FakeAgent = { settleAndWake: async () => {} }
  const conn = new AgentSideConnection(
    client => {
      const update = (u: Record<string, unknown>) =>
        client.sessionUpdate({ sessionId: SESSION_ID, update: u as never })
      agent.settleAndWake = async () => {
        if (!advertisesAsyncTasks(agent.initParams)) return
        await update({
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "bx1",
          state: "completed",
          summary: 'Background command "sleep 20; echo done" completed (exit code 0)',
          outputFilePath: "/tmp/tasks/bx1.output",
          toolCallId: "toolu_1",
        })
        await update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The background command printed: done" },
        })
        await update({
          sessionUpdate: "usage_update",
          size: 200_000,
          used: 12_000,
          cost: { amount: 0.02, currency: "USD" },
          _meta: { "_claude/origin": { kind: "task-notification" } },
        })
      }
      return {
        async initialize(params) {
          agent.initParams = params as unknown as Record<string, unknown>
          return { protocolVersion: 1, agentCapabilities: {} }
        },
        async newSession() {
          return { sessionId: SESSION_ID }
        },
        async authenticate() {
          return {}
        },
        async prompt() {
          if (advertisesAsyncTasks(agent.initParams)) {
            await update({
              sessionUpdate: "async_task_spawned",
              asyncTaskId: "bx1",
              name: "sleep 20; echo done",
              taskType: "shell",
              description: "sleep 20; echo done",
              showInTranscript: true,
              canStop: true,
              outputFilePath: "/tmp/tasks/bx1.output",
              toolCallId: "toolu_1",
            })
          }
          await update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Started it in the background." },
          })
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

describe("createAcpClient — AIR asyncTasks + out-of-turn events", () => {
  it("advertises the AIR asyncTasks capability in the exact _meta shape claude-agent-acp reads", async () => {
    const { agent, clientStreams } = startFakeAgent()
    await createAcpClient(clientStreams)
    expect(advertisesAsyncTasks(agent.initParams)).toBe(true)
    expect((agent.initParams?.clientCapabilities as { _meta: unknown })._meta).toEqual({
      jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
    })
  })

  it("does not advertise it when opted out", async () => {
    const { agent, clientStreams } = startFakeAgent()
    await createAcpClient({ ...clientStreams, capabilities: { asyncTasks: false } })
    expect(advertisesAsyncTasks(agent.initParams)).toBe(false)
  })

  it("surfaces an in-turn task start as a background-task event on the turn's stream", async () => {
    const { clientStreams } = startFakeAgent()
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    const events = await drain(session.prompt({ messages: [{ type: "text", text: "go" }] }))
    expect(events.find(e => e.kind === "background-task")).toEqual({
      kind: "background-task",
      sessionId: SESSION_ID,
      phase: "started",
      task: {
        taskId: "bx1",
        taskKind: "shell",
        description: "sleep 20; echo done",
        outputFile: "/tmp/tasks/bx1.output",
        status: "running",
        toolCallId: "toolu_1",
      },
    })
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("delivers the settle + the agent's autonomous wake-up to out-of-turn listeners instead of dropping them", async () => {
    const { agent, clientStreams } = startFakeAgent()
    const client = await createAcpClient(clientStreams)
    const session = await client.newSession({ cwd: "/tmp" })
    const outOfTurn: StreamEvent[] = []
    const unsubscribe = session.onOutOfTurnEvent(evt => outOfTurn.push(evt))
    await drain(session.prompt({ messages: [{ type: "text", text: "go" }] }))

    await agent.settleAndWake()
    await tick()

    expect(outOfTurn).toEqual([
      {
        kind: "background-task",
        sessionId: SESSION_ID,
        phase: "settled",
        task: {
          taskId: "bx1",
          outputFile: "/tmp/tasks/bx1.output",
          status: "completed",
          summary: 'Background command "sleep 20; echo done" completed (exit code 0)',
          toolCallId: "toolu_1",
        },
      },
      { kind: "text-delta", sessionId: SESSION_ID, text: "The background command printed: done" },
      {
        kind: "usage_update",
        sessionId: SESSION_ID,
        size: 200_000,
        used: 12_000,
        cost: { amount: 0.02, currency: "USD" },
        origin: "task-notification",
      },
    ])

    // Unsubscribed: later out-of-turn traffic goes nowhere, and never leaks
    // into the next turn's stream either.
    unsubscribe()
    await agent.settleAndWake()
    await tick()
    expect(outOfTurn).toHaveLength(3)
    const next = await drain(session.prompt({ messages: [{ type: "text", text: "again" }] }))
    expect(next.some(e => e.kind === "text-delta" && e.text.includes("printed: done"))).toBe(false)
  })
})
