/**
 * `SessionsRegistry.gcSessions` — bulk garbage-collect of terminal sessions
 * (archive by default, `forget` to drop the descriptor). Mirrors
 * session-archive-mcp.test.ts's registry harness.
 */

import { describe, it, expect } from "vitest"

import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"

let n = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
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

function spawnLive(registry: ReturnType<typeof reg>): string {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "claude-code",
  }).id
}

function spawnDead(registry: ReturnType<typeof reg>): string {
  const id = spawnLive(registry)
  registry.kill(id)
  return id
}

describe("gcSessions", () => {
  it("archives terminal sessions by default and never touches a live one", () => {
    const registry = reg()
    const dead = spawnDead(registry)
    const live = spawnLive(registry)

    const res = registry.gcSessions({})
    expect(res.mode).toBe("archived")
    expect(res.ids).toContain(dead)
    expect(res.ids).not.toContain(live)
    expect(registry.get(dead)?.archived).toBe(true)
    expect(registry.get(live)?.archived).not.toBe(true)
    registry.shutdown()
  })

  it("forget drops the descriptor entirely", () => {
    const registry = reg()
    const dead = spawnDead(registry)

    const res = registry.gcSessions({ forget: true })
    expect(res.mode).toBe("forgotten")
    expect(res.ids).toContain(dead)
    expect(registry.get(dead)).toBeUndefined()
    registry.shutdown()
  })

  it("olderThanDays keeps sessions more recent than the cutoff", () => {
    const registry = reg()
    const oldId = spawnDead(registry)
    const recentId = spawnDead(registry)
    const old = registry.get(oldId)
    if (old) old.endedAt = new Date(Date.now() - 10 * 86_400_000).toISOString()

    const res = registry.gcSessions({ olderThanDays: 7 })
    expect(res.ids).toContain(oldId)
    expect(res.ids).not.toContain(recentId)
    registry.shutdown()
  })

  it("onlyIds scopes GC to an allowlist", () => {
    const registry = reg()
    const a = spawnDead(registry)
    const b = spawnDead(registry)

    const res = registry.gcSessions({ onlyIds: new Set([a]) })
    expect(res.ids).toEqual([a])
    expect(registry.get(b)?.archived).not.toBe(true)
    registry.shutdown()
  })
})
