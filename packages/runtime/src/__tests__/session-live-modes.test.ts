/**
 * The daemon's per-session mode READ-SURFACE: a live agent-cli session's
 * advertised ACP mode registry (`SessionModeState.availableModes`) and the
 * currently-active mode id are stamped onto the descriptor at read time
 * (list()/get()), so `GET /sessions` and `GET /sessions/:id` carry them. This is
 * the server half of the VS Code posture picker's native-vs-advisory
 * resolution: without it the client can only offer prompt-injected advisory
 * postures. Coverage: presence for a live ACP arm, absence for an arm with no
 * native registry, and the never-persisted (read-time-only) contract.
 */

import { describe, it, expect } from "vitest"

import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionMode } from "../canonical-posture.js"

let n = 0

function fakeAgentSession(
  modes?: readonly SessionMode[],
  currentModeId?: string,
): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
    ...(modes ? { availableModes: modes } : {}),
    ...(currentModeId ? { currentModeId } : {}),
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function reg() {
  return createSessionsRegistry({ sessionEvents: createSessionEventBus(), persist: false })
}

function spawnLive(
  registry: ReturnType<typeof reg>,
  agentSession: AgentSessionLike,
): string {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    adapterSlug: "claude-code",
    agentSession,
  }).id
}

const NATIVE_MODES: SessionMode[] = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
  { id: "acceptEdits", name: "Accept Edits" },
  { id: "bypassPermissions", name: "Bypass" },
]

describe("session read-surface — live ACP modes", () => {
  it("stamps availableModes + currentModeId on get() and list()", () => {
    const registry = reg()
    const id = spawnLive(registry, fakeAgentSession(NATIVE_MODES, "acceptEdits"))
    try {
      const got = registry.get(id)
      expect(got?.availableModes?.map(m => m.id)).toEqual([
        "default",
        "plan",
        "acceptEdits",
        "bypassPermissions",
      ])
      expect(got?.currentModeId).toBe("acceptEdits")

      const listed = registry.list().find(s => s.id === id)
      expect(listed?.availableModes?.map(m => m.id)).toEqual([
        "default",
        "plan",
        "acceptEdits",
        "bypassPermissions",
      ])
      expect(listed?.currentModeId).toBe("acceptEdits")
    } finally {
      registry.shutdown()
    }
  })

  it("omits both fields for an arm with no native mode registry", () => {
    const registry = reg()
    const id = spawnLive(registry, fakeAgentSession())
    try {
      const got = registry.get(id)
      expect(got?.availableModes).toBeUndefined()
      expect(got?.currentModeId).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})
