/**
 * Agent-host empty-turn propagation.
 *
 * An empty turn (no assistant text, no tool call, not awaiting input) is a
 * silent no-op — e.g. the claude-code adapter's underlying CLI hit
 * "Authentication required" in CI and returned nothing. Previously the
 * workflow agent-host resolved `waitTurnEnd` on ANY turn-end, so the step
 * "succeeded" and the workflow run reported `status: "done"` — letting a PR
 * gate pass a review that never ran. The host now FAILS the step on an empty
 * turn so the run reports `status: "failed"` and the caller can fall back.
 */

import { describe, it, expect } from "vitest"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { AgentAdapterResolver } from "../http-server.js"

/** Yields a turn-end with no text and no tool call — the empty (no-op) case. */
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
      yield { kind: "text-delta", text: "here is the review\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function makeHost(
  registry: ReturnType<typeof createSessionsRegistry>,
  sessionEvents: ReturnType<typeof createSessionEventBus>,
): SessionsRegistryAgentHost {
  // resolveAgentAdapter is unused here — we spawn sessions directly on the
  // registry and drive the host's sendPromptAndWait/waitTurnEnd surface, so a
  // never-returning stub satisfies the type without being exercised.
  const resolveAgentAdapter: AgentAdapterResolver = async () => {
    throw new Error("resolveAgentAdapter is not exercised by this test")
  }
  return new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)
}

describe("agent-host: empty turn fails the step", () => {
  it("rejects sendPromptAndWait on an empty turn (auth-failed no-op)", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const host = makeHost(registry, sessionEvents)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: silentAgentSession(),
      adapterSlug: "fake",
    })
    await expect(host.sendPromptAndWait(desc.id, "go")).rejects.toThrow(/empty turn/)
    registry.shutdown()
  })

  it("resolves sendPromptAndWait on a productive turn", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const host = makeHost(registry, sessionEvents)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: talkingAgentSession(),
      adapterSlug: "fake",
    })
    await expect(host.sendPromptAndWait(desc.id, "go")).resolves.toBeUndefined()
    registry.shutdown()
  })
})
