/**
 * `SessionDescriptor.capabilities` — stamped from the live agent session at
 * attach time. `steering` is surfaced in `session_list`'s compact rows so a
 * sender can predict whether a `steer` message can reach a running turn.
 * `commandsSupported` is `steer` PRESENCE alone (not `steeringSupported`,
 * which is a separate ACP extension a harness can decline) — the ACP-arm
 * signal `session_capabilities` reads to derive `arm`/`commandsSupported`
 * (see session-capabilities.ts).
 */

import { describe, expect, it } from "vitest"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { compactSessionItem } from "../session-tools.js"
import { buildSessionCapabilities } from "../session-capabilities.js"

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
  it("true only when the session can steer AND the agent advertised it; commandsSupported tracks steer presence alone", () => {
    const registry = createSessionsRegistry({ persist: false })
    const spawn = (a: AgentSessionLike) =>
      registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: a, adapterSlug: "mock" })
    const yes = spawn(agent({ steeringSupported: true, steer: async () => "steered" }))
    const notAdvertised = spawn(agent({ steeringSupported: false, steer: async () => "unsupported" }))
    const noMethod = spawn(agent({}))
    expect(registry.get(yes.id)?.capabilities).toEqual({ steering: true, commandsSupported: true })
    expect(registry.get(notAdvertised.id)?.capabilities).toEqual({
      steering: false,
      commandsSupported: true,
    })
    expect(registry.get(noMethod.id)?.capabilities).toEqual({
      steering: false,
      commandsSupported: false,
    })
    expect(compactSessionItem(registry.get(yes.id)!).steering).toBe(true)
    expect(compactSessionItem(registry.get(noMethod.id)!)).not.toHaveProperty("steering")
    registry.shutdown()
  })
})

describe("hooks in session_capabilities", () => {
  const hooks = [
    {
      event: "tool.call" as const,
      native_event: "PreToolUse",
      path: "admission" as const,
      can_block: true,
      handlers: ["command" as const],
    },
  ]

  it("reports the session harness's declared hooks under hooks.native", () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent({}),
      adapterSlug: "mock",
      nativeHooks: hooks,
    })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect(body.hooks).toEqual({ native: hooks })
    registry.shutdown()
  })

  it("omits the hooks key when the harness declares none", () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent({}),
      adapterSlug: "mock",
    })
    const body = buildSessionCapabilities(registry.get(desc.id)!, 0)
    expect("hooks" in body).toBe(false)
    registry.shutdown()
  })
})

describe("posture enforcement in session_capabilities", () => {
  const modes = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ]

  it("labels opencode-style spawn-enforced postures spawn-config, native ones native, the rest advisory", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const enforced = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent({
        availableModes: modes,
        spawnEnforcedPostures: ["bypass", "accept-edits", "read-only"],
      }),
      adapterSlug: "opencode",
      posture: "bypass",
    })
    const advisory = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent({ availableModes: modes }),
      adapterSlug: "hermes",
      posture: "bypass",
    })

    const body = buildSessionCapabilities(registry.get(enforced.id)!, 0)
    expect(body.postureEnforcement).toBe("spawn-config")
    expect(body.canonicalPostureEnforcement).toEqual({
      default: "native",
      plan: "native",
      "accept-edits": "spawn-config",
      bypass: "spawn-config",
      "read-only": "spawn-config",
    })

    const advisoryBody = buildSessionCapabilities(registry.get(advisory.id)!, 0)
    expect(advisoryBody.postureEnforcement).toBe("prompt-advisory")
    expect(advisoryBody.canonicalPostureEnforcement?.bypass).toBe("prompt-advisory")
    registry.shutdown()
  })
})
