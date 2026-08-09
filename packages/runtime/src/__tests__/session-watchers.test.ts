/**
 * Per-session watcher counter (#session-visibility) — the ephemeral
 * "is anything supervising this session" signal. `monitorSessionWait`
 * (backing GET /sessions/:id/wait + session_monitor) inc/decrements it; the
 * registry stamps the live count onto the descriptor at read time, exactly
 * like `processAlive`, and never persists it.
 */

import { describe, it, expect } from "vitest"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("session watchers counter", () => {
  it("stamps the live waiter count onto list()/get(), balancing inc/dec", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    // No waiters yet — the field is present and zero, not absent.
    expect(reg.get(desc.id)?.watchers).toBe(0)

    reg.incWatchers(desc.id)
    reg.incWatchers(desc.id)
    expect(reg.get(desc.id)?.watchers).toBe(2)
    expect(reg.list().find(d => d.id === desc.id)?.watchers).toBe(2)

    reg.decWatchers(desc.id)
    expect(reg.get(desc.id)?.watchers).toBe(1)

    reg.decWatchers(desc.id)
    expect(reg.get(desc.id)?.watchers).toBe(0)

    reg.shutdown()
  })

  it("clamps at zero — an unbalanced decrement never goes negative", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    reg.decWatchers(desc.id)
    expect(reg.get(desc.id)?.watchers).toBe(0)

    reg.shutdown()
  })
})
