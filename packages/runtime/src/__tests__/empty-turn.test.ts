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
