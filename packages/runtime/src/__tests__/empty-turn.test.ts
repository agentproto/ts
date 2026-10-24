/**
 * Empty-turn surfacing (#1/#2).
 *
 * A turn that completes the normal way but yields ZERO assistant text and
 * zero tool calls is a silent no-op — the usual cause is an invalid /
 * unrecognized model id, or a provider (Grok via hermes/OpenRouter was the
 * live report) that returns an empty completion at $0. Previously this
 * reported as an ordinary green `session:turn-end`, so an orchestrator
 * mistook it for progress. The turn now carries `empty: true` on the bus
 * event (→ event ring → session_events_poll) and appends a visible warning
 * line to the ring buffer. A productive turn carries neither.
 */

import { describe, it, expect } from "vitest"
import {
  createSessionsRegistry,
  type AgentSessionLike,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionTurnEndEvent } from "../session-event-bus.js"

/** Yields a turn-end with no text and no tool call — the empty case. */
function silentAgentSession(): AgentSessionLike {
  return {
    sessionId: "silent",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Yields real assistant text before the turn-end — the productive case. */
function talkingAgentSession(): AgentSessionLike {
  return {
    sessionId: "talking",
    async *send() {
      yield { kind: "text-delta", text: "here is the answer\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Yields only a tool call (no assistant text) — still productive. */
function toolOnlyAgentSession(): AgentSessionLike {
  return {
    sessionId: "tool-only",
    async *send() {
      yield { kind: "tool-call", toolName: "read", toolCallId: "t1", arguments: {} }
      yield { kind: "tool-result", toolName: "read", toolCallId: "t1", result: "ok" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Yields only an `inbox_ack` tool call (no assistant text) — the no-op ack case. */
function ackOnlyAgentSession(toolName = "inbox_ack"): AgentSessionLike {
  return {
    sessionId: "ack-only",
    async *send() {
      yield { kind: "tool-call", toolName, toolCallId: "t1", arguments: { ids: ["m1"] } }
      yield { kind: "tool-result", toolName, toolCallId: "t1", result: "ok" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Yields an `inbox_ack` plus assistant text — a turn that said something. */
function ackAndTalkingAgentSession(): AgentSessionLike {
  return {
    sessionId: "ack-and-talking",
    async *send() {
      yield { kind: "tool-call", toolName: "inbox_ack", toolCallId: "t1", arguments: { ids: ["m1"] } }
      yield { kind: "tool-result", toolName: "inbox_ack", toolCallId: "t1", result: "ok" }
      yield { kind: "text-delta", text: "RIEN\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** Yields `inbox_ack` plus another tool call — not a pure acknowledgement. */
function ackAndSendAgentSession(): AgentSessionLike {
  return {
    sessionId: "ack-and-send",
    async *send() {
      yield { kind: "tool-call", toolName: "inbox_ack", toolCallId: "t1", arguments: { ids: ["m1"] } }
      yield { kind: "tool-result", toolName: "inbox_ack", toolCallId: "t1", result: "ok" }
      yield { kind: "tool-call", toolName: "message_send", toolCallId: "t2", arguments: { text: "hi" } }
      yield { kind: "tool-result", toolName: "message_send", toolCallId: "t2", result: "ok" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function runOneTurn(agent: AgentSessionLike): Promise<SessionTurnEndEvent> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const turnEnds: SessionTurnEndEvent[] = []
  sessionEvents.on("session:turn-end", ev => turnEnds.push(ev))

  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: agent,
    adapterSlug: "fake",
  })
  await registry.sendPrompt(desc.id, "go")
  registry.shutdown()

  expect(turnEnds).toHaveLength(1)
  const [ev] = turnEnds
  if (!ev) throw new Error("no turn-end event captured")
  return ev
}

describe("empty-turn detection", () => {
  it("flags a turn with no assistant text and no tool call as empty", async () => {
    const ev = await runOneTurn(silentAgentSession())
    expect(ev.empty).toBe(true)
  })

  it("does NOT flag a turn that produced assistant text", async () => {
    const ev = await runOneTurn(talkingAgentSession())
    expect(ev.empty).toBeUndefined()
  })

  it("does NOT flag a turn that only made tool calls", async () => {
    const ev = await runOneTurn(toolOnlyAgentSession())
    expect(ev.empty).toBeUndefined()
  })

  it("emits a warning line into the ring buffer on an empty turn", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: silentAgentSession(),
      adapterSlug: "fake",
    })
    await registry.sendPrompt(desc.id, "go")

    const lines: string[] = []
    const unsub = registry.attach(desc.id, line => lines.push(line))
    if (unsub) unsub()
    registry.shutdown()

    expect(lines.some(l => l.includes("empty turn"))).toBe(true)
  })
})

describe("silent-turn detection", () => {
  it("flags a turn whose only tool call is inbox_ack and which produced no text", async () => {
    const ev = await runOneTurn(ackOnlyAgentSession())
    expect(ev.silent).toBe(true)
    expect(ev.empty).toBeUndefined()
  })

  it("matches an inbox_ack tool name behind an MCP server prefix", async () => {
    const ev = await runOneTurn(ackOnlyAgentSession("mcp__agentproto__inbox_ack"))
    expect(ev.silent).toBe(true)
    expect(ev.empty).toBeUndefined()
  })

  it("does NOT flag an inbox_ack turn that also produced assistant text", async () => {
    const ev = await runOneTurn(ackAndTalkingAgentSession())
    expect(ev.silent).not.toBe(true)
  })

  it("does NOT flag a turn that acknowledged an inbox item and called another tool", async () => {
    const ev = await runOneTurn(ackAndSendAgentSession())
    expect(ev.silent).not.toBe(true)
  })
})
