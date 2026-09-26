/**
 * `SessionDescriptor.capabilities.steering` — stamped from the live agent
 * session at attach time and surfaced in `session_list`'s compact rows, so a
 * sender can predict whether a `steer` message can reach a running turn.
 */

import { describe, expect, it } from "vitest"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { compactSessionItem } from "../session-tools.js"

function agent(extra: Partial<AgentSessionLike>): AgentSessionLike {
  return {
    sessionId: "acp",
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
    ...extra,
  }
}

describe("capabilities.steering", () => {
  it("true only when the session can steer AND the agent advertised it", () => {
    const registry = createSessionsRegistry({ persist: false })
    const spawn = (a: AgentSessionLike) =>
      registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: a, adapterSlug: "mock" })
    const yes = spawn(agent({ steeringSupported: true, steer: async () => "steered" }))
    const notAdvertised = spawn(agent({ steeringSupported: false, steer: async () => "unsupported" }))
    const noMethod = spawn(agent({}))
    expect(registry.get(yes.id)?.capabilities).toEqual({ steering: true })
    expect(registry.get(notAdvertised.id)?.capabilities).toEqual({ steering: false })
    expect(registry.get(noMethod.id)?.capabilities).toEqual({ steering: false })
    expect(compactSessionItem(registry.get(yes.id)!).steering).toBe(true)
    expect(compactSessionItem(registry.get(noMethod.id)!)).not.toHaveProperty("steering")
    registry.shutdown()
  })
})
