/**
 * Learning a model switch sent as an ORDINARY prompt (not via
 * `agent_set_model`/`SessionsRegistry.setModel`).
 *
 * This is the exact shape the hermes spawn recipe's `/model <id>` shortcut
 * produces: the switch is typed as a plain conversational turn, so
 * `applyModelCommand`'s dedicated control turn never runs and the registry
 * never learns of it through `setModel`. `runAgentTurn` watches the outgoing
 * text for a `/model <id>` command and the adapter's own reply for a loose
 * switch acknowledgement (`isModelSwitchAcknowledgement`), then records the
 * result on `activeModel` — distinct from `model` (the spawn-time request),
 * which is never overwritten by this path.
 */

import { describe, it, expect } from "vitest"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"

/** Replies the way hermes does to a `/model <id>` control turn. */
function ackingAgentSession(): AgentSessionLike {
  return {
    sessionId: "acking-session",
    async *send() {
      yield { kind: "text-delta", text: "Model switched to: z-ai/glm-5.3-flash · Provider: openrouter\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** An ordinary turn that never acknowledges any switch. */
function talkingAgentSession(): AgentSessionLike {
  return {
    sessionId: "talking-session",
    async *send() {
      yield { kind: "text-delta", text: "here is the answer\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("learning a /model switch sent as an ordinary prompt", () => {
  it("records activeModel from the adapter's acknowledgement without touching model", async () => {
    const sessionEvents = createSessionEventBus()
    const seen: SessionEvent[] = []
    sessionEvents.onAny(ev => seen.push(ev))
    const registry = createSessionsRegistry({ sessionEvents, persist: false })

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: ackingAgentSession(),
      adapterSlug: "hermes",
      model: "z-ai/glm-5.2@openrouter",
    })

    await registry.sendPrompt(desc.id, "/model z-ai/glm-5.3-flash")

    const updated = registry.get(desc.id)
    expect(updated?.model).toBe("z-ai/glm-5.2@openrouter")
    expect(updated?.activeModel).toBe("z-ai/glm-5.3-flash")
    registry.shutdown()

    const modelChanged = seen.find(ev => ev.type === "session:model-changed")
    expect(modelChanged).toMatchObject({
      type: "session:model-changed",
      sessionId: desc.id,
      model: "z-ai/glm-5.2@openrouter",
      activeModel: "z-ai/glm-5.3-flash",
    })
  })

  it("does NOT learn a switch from an ordinary turn that never sent /model", async () => {
    const sessionEvents = createSessionEventBus()
    const seen: SessionEvent[] = []
    sessionEvents.onAny(ev => seen.push(ev))
    const registry = createSessionsRegistry({ sessionEvents, persist: false })

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: talkingAgentSession(),
      adapterSlug: "hermes",
      model: "z-ai/glm-5.2@openrouter",
    })

    await registry.sendPrompt(desc.id, "what model are you running?")

    const updated = registry.get(desc.id)
    expect(updated?.model).toBe("z-ai/glm-5.2@openrouter")
    expect(updated?.activeModel).toBeUndefined()
    expect(seen.find(ev => ev.type === "session:model-changed")).toBeUndefined()
    registry.shutdown()
  })

  it("does NOT learn a switch when /model was sent but the adapter never acknowledged it", async () => {
    const sessionEvents = createSessionEventBus()
    const seen: SessionEvent[] = []
    sessionEvents.onAny(ev => seen.push(ev))
    const registry = createSessionsRegistry({ sessionEvents, persist: false })

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: talkingAgentSession(),
      adapterSlug: "hermes",
      model: "z-ai/glm-5.2@openrouter",
    })

    await registry.sendPrompt(desc.id, "/model z-ai/glm-5.3-flash")

    const updated = registry.get(desc.id)
    expect(updated?.activeModel).toBeUndefined()
    expect(seen.find(ev => ev.type === "session:model-changed")).toBeUndefined()
    registry.shutdown()
  })
})
