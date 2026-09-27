/**
 * A turn whose adapter stream emits an in-band `error` event and then ends
 * the generator WITHOUT an explicit `turn-end` (no throw, no adapter-
 * reported terminal event) previously synthesized a turn-end with
 * `reason: "exited"` — indistinguishable from a session that finished a
 * clean turn and went idle. `agent_sessions_list`/`session_list` showed
 * `status: running, busy: false` with no error field, and a supervisor
 * polling the session was never alerted.
 *
 * `runAgentTurn` now tracks whether an `error` stream event occurred THIS
 * turn (independent of the cross-turn `rt.lastErrorMessage`) and classifies
 * the synthesized turn-end as `"error"` instead of `"exited"` — which
 * cascades into `lastTurnErroredAt`/`lastTurnErrorMessage` on the
 * descriptor, the compact list projections, and the `session:turn-end` bus
 * event's `reason`/`error` fields.
 */

import { describe, it, expect } from "vitest"
import {
  createSessionsRegistry,
  type AgentSessionLike,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionTurnEndEvent } from "../session-event-bus.js"
import { compactSessionItem } from "../session-tools.js"

/** Mirrors the real incident's events.jsonl tail: text-delta, then an
 *  `error` stream event, then the generator just returns — no thrown
 *  exception, no adapter-reported `turn-end`. */
function errorsThenEndsAgentSession(): AgentSessionLike {
  return {
    sessionId: "erroring",
    async *send() {
      yield { kind: "text-delta", text: "API Error: 400 ..." }
      yield { kind: "error", error: { message: "Internal error: API Error: 400 ..." } }
      // No turn-end — the generator just ends.
    },
    async cancel() {},
    async close() {},
  }
}

/** A normal, productive turn — used to confirm recovery clears the markers. */
function talkingAgentSession(): AgentSessionLike {
  return {
    sessionId: "talking",
    async *send() {
      yield { kind: "text-delta", text: "all good\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** First turn matches `errorsThenEndsAgentSession`'s shape; every turn after
 *  that is a normal, productive one — the same live adapter connection a
 *  real ACP session keeps between prompts (a fresh `send()` generator per
 *  turn, not a fresh process). Used to prove recovery clears the markers
 *  without reaching into registry internals. */
function erroringThenRecoveringAgentSession(): AgentSessionLike {
  let turn = 0
  return {
    sessionId: "recovering",
    async *send() {
      turn += 1
      if (turn === 1) {
        yield { kind: "text-delta", text: "API Error: 400 ..." }
        yield { kind: "error", error: { message: "Internal error: API Error: 400 ..." } }
        return
      }
      yield { kind: "text-delta", text: "all good\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("in-band turn error surfacing", () => {
  it("synthesizes reason:\"error\" (not \"exited\") when the generator ends after an error event", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const turnEnds: SessionTurnEndEvent[] = []
    sessionEvents.on("session:turn-end", ev => turnEnds.push(ev))

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: errorsThenEndsAgentSession(),
      adapterSlug: "fake",
    })
    await registry.sendPrompt(desc.id, "go")

    expect(turnEnds).toHaveLength(1)
    const [ev] = turnEnds
    expect(ev?.reason).toBe("error")
    expect(ev?.error).toBe("Internal error: API Error: 400 ...")

    const after = registry.get(desc.id)
    expect(after?.status).toBe("running") // process stayed alive — no crash
    expect(after?.lastTurnErroredAt).toBeDefined()
    expect(after?.lastTurnErrorMessage).toBe("Internal error: API Error: 400 ...")
    expect(after?.lastTurnReason).toBe("error")

    registry.shutdown()
  })

  it("surfaces the error on the compact session-list projection", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: errorsThenEndsAgentSession(),
      adapterSlug: "fake",
    })
    await registry.sendPrompt(desc.id, "go")

    const after = registry.get(desc.id)!
    const compact = compactSessionItem(after)
    expect(compact.lastTurnErroredAt).toBeDefined()
    expect(compact.lastTurnErrorMessage).toBe("Internal error: API Error: 400 ...")
    expect(compact.lastTurnReason).toBe("error")

    registry.shutdown()
  })

  it("a later clean turn clears lastTurnErroredAt / lastTurnErrorMessage", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: erroringThenRecoveringAgentSession(),
      adapterSlug: "fake",
    })
    await registry.sendPrompt(desc.id, "go")
    expect(registry.get(desc.id)?.lastTurnErroredAt).toBeDefined()

    // Same live adapter connection, a fresh (productive) turn.
    await registry.sendPrompt(desc.id, "go again")

    const after = registry.get(desc.id)
    expect(after?.lastTurnErroredAt).toBeUndefined()
    expect(after?.lastTurnErrorMessage).toBeUndefined()

    registry.shutdown()
  })

  it("a productive turn never carries lastTurnErroredAt / lastTurnErrorMessage", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: talkingAgentSession(),
      adapterSlug: "fake",
    })
    await registry.sendPrompt(desc.id, "go")

    const after = registry.get(desc.id)
    expect(after?.lastTurnErroredAt).toBeUndefined()
    expect(after?.lastTurnErrorMessage).toBeUndefined()

    registry.shutdown()
  })
})
