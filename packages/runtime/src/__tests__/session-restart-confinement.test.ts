/**
 * `restartAgentSession` carries the spawn-time guarantees forward: the
 * recorded effective `commandSandbox` is re-applied to the respawned adapter
 * (and echoed on the new descriptor, so the NEXT restart keeps it too), and a
 * permission-hold session stays in hold. Mock style follows
 * session-restart-override.test.ts: `startSession` is a stub that records
 * what it was handed.
 */

import { describe, expect, it } from "vitest"
import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_confine_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

type Captured = { commandSandbox?: string; permissionHold?: boolean }

function makeResolver(): { resolver: AgentAdapterResolver; captured: Captured[] } {
  const captured: Captured[] = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: async (o: Captured) => {
      captured.push({
        ...(o.commandSandbox !== undefined ? { commandSandbox: o.commandSandbox } : {}),
        ...(o.permissionHold !== undefined ? { permissionHold: o.permissionHold } : {}),
      })
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
  return { resolver, captured }
}

describe("restartAgentSession — confinement and permission hold survive a restart", () => {
  it("re-applies the recorded commandSandbox and permissionHold, across consecutive restarts", async () => {
    const { resolver, captured } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    try {
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession(),
        adapterSlug: "mock",
        commandSandbox: "strict",
        permissionHold: true,
      })
      expect(prev.commandSandbox).toBe("strict")
      expect(prev.permissionHold).toBe(true)

      const first = await restartAgentSession(registry, resolver, prev, { forceAgentResume: true })
      expect(captured[0]).toEqual({ commandSandbox: "strict", permissionHold: true })
      expect(first.desc.commandSandbox).toBe("strict")
      expect(first.desc.permissionHold).toBe(true)

      // The echo is what makes the guarantee durable: restart the restart.
      const second = await restartAgentSession(registry, resolver, first.desc, {
        forceAgentResume: true,
      })
      expect(captured[1]).toEqual({ commandSandbox: "strict", permissionHold: true })
      expect(second.desc.commandSandbox).toBe("strict")
      expect(second.desc.permissionHold).toBe(true)
    } finally {
      registry.shutdown()
    }
  })

  it("adds neither when the prior session had none", async () => {
    const { resolver, captured } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    try {
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession(),
        adapterSlug: "mock",
      })
      const restarted = await restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
      })
      expect(captured[0]).toEqual({})
      expect(restarted.desc.commandSandbox).toBeUndefined()
      expect(restarted.desc.permissionHold).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})
