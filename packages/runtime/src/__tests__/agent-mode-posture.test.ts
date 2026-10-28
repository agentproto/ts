/**
 * An agent-caused mode change (AIP-45 `mode-changed`, `cause: "agent"`)
 * updates the session descriptor's `posture`, so `agent_sessions_list`, the
 * VS Code chip, posture-reading policies and a later restart see the mode the
 * agent is actually in, not the spawn-time one.
 *
 * Covers:
 *   - a mastra-controller-shaped event (plan approved, `transitionsTo` a
 *     native mode the canonical vocabulary does not name) and an ACP
 *     `current_mode_update` mapped to `mode-changed` (claude-code leaving plan);
 *   - a caller-caused change is applied once, by the caller path, never again
 *     from its echo on the stream;
 *   - a restart starts in the CURRENT posture;
 *   - the agent never widens past the caller's ceiling: the descriptor records
 *     the agent's mode, a warning is emitted, and a restart clamps back.
 */

import { describe, it, expect } from "vitest"
import type { SessionMode } from "@agentproto/acp/client"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentSessionResumer,
  type AgentStreamEvent,
} from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { restartAgentSession, tryRestartInPlace } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { Posture } from "../session-config.js"

const mode = (id: string): SessionMode => ({ id, name: id })

/** An agent session whose next turn yields `events` then ends. */
function scriptedSession(
  events: AgentStreamEvent[][],
  overrides: Partial<AgentSessionLike> = {},
): AgentSessionLike {
  let turn = 0
  return {
    sessionId: "acp_s",
    async *send() {
      for (const evt of events[turn++] ?? []) yield evt
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    ...overrides,
  }
}

function setup(
  events: AgentStreamEvent[][],
  spawn: { posture?: Posture; adapterSlug?: string } = {},
  overrides: Partial<AgentSessionLike> = {},
  registryOpts: { resumeAgent?: AgentSessionResumer } = {},
) {
  const bus = createSessionEventBus()
  const seen: SessionEvent[] = []
  bus.onAny(ev => seen.push(ev))
  const reg = createSessionsRegistry({ persist: false, sessionEvents: bus, ...registryOpts })
  const desc = reg.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: scriptedSession(events, overrides),
    adapterSlug: spawn.adapterSlug ?? "fake",
    label: "conv",
    ...(spawn.posture !== undefined ? { posture: spawn.posture } : {}),
  })
  const postureEvents = () =>
    seen.filter(ev => ev.type === "session:config-changed" && ev.axis === "posture")
  return { reg, desc, seen, postureEvents }
}

describe("agent-caused mode-changed updates the descriptor posture", () => {
  it("ACP current_mode_update (claude-code leaves plan): the canonical posture lands on the descriptor", async () => {
    const { reg, desc, postureEvents } = setup(
      [[{ kind: "mode-changed", modeId: "default", previousModeId: "plan", cause: "agent" }]],
      { posture: "plan" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("default")
    expect(postureEvents()).toEqual([
      {
        type: "session:config-changed",
        sessionId: desc.id,
        axis: "posture",
        value: "default",
        label: "conv",
        ts: expect.any(String),
      },
    ])
    reg.shutdown()
  })

  it("normalises the harness spelling through the canonical alias map (acceptEdits -> accept-edits)", async () => {
    const { reg, desc } = setup(
      [[{ kind: "mode-changed", modeId: "acceptEdits", previousModeId: "plan", cause: "agent" }]],
      { posture: "accept-edits" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("accept-edits")
    reg.shutdown()
  })

  it("mastra-controller plan approved into a native mode with no canonical name: keeps the raw mode id", async () => {
    const { reg, desc, postureEvents } = setup(
      [
        [
          {
            kind: "mode-changed",
            modeId: "execute",
            previousModeId: "plan",
            cause: "agent",
            reason: "plan approved",
          } as AgentStreamEvent,
        ],
      ],
      { posture: "plan", adapterSlug: "mastra-controller" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toEqual({ harnessModeId: "execute" })
    expect(postureEvents()).toHaveLength(1)
    reg.shutdown()
  })

  it("a no-op agent switch (already in that posture) emits nothing", async () => {
    const { reg, desc, postureEvents } = setup(
      [[{ kind: "mode-changed", modeId: "plan", previousModeId: "plan", cause: "agent" }]],
      { posture: "plan" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("plan")
    expect(postureEvents()).toHaveLength(0)
    reg.shutdown()
  })

  it("a caller-caused change is applied once by agent_set_posture, never again from its stream echo", async () => {
    const { reg, desc, postureEvents } = setup(
      // The echo of the caller's own switch arrives on the next turn.
      [[{ kind: "mode-changed", modeId: "plan", previousModeId: "default", cause: "caller" }]],
      { posture: "default" },
      {
        availableModes: [mode("default"), mode("plan")],
        async setSessionMode(modeId: string) {
          return { applied: true, modeId }
        },
      },
    )
    await expect(reg.setPosture(desc.id, "plan")).resolves.toMatchObject({ applied: true })
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("plan")
    expect(postureEvents()).toHaveLength(1)
    reg.shutdown()
  })

  it("a caller echo never overwrites the descriptor, even one naming a different mode", async () => {
    const { reg, desc, postureEvents } = setup(
      [[{ kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "plan", cause: "caller" }]],
      { posture: "plan" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("plan")
    expect(postureEvents()).toHaveLength(0)
    reg.shutdown()
  })
})

describe("the agent never widens past the caller's ceiling", () => {
  it("accept-edits ceiling, agent goes plan -> bypass: records the agent's mode, warns, keeps the ceiling", async () => {
    const { reg, desc, seen } = setup(
      [
        [
          { kind: "mode-changed", modeId: "plan", previousModeId: "acceptEdits", cause: "agent" },
          { kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "plan", cause: "agent" },
        ],
      ],
      { posture: "accept-edits" },
    )
    await reg.sendPrompt(desc.id, "go")
    const after = reg.get(desc.id)
    // Truthful: the harness IS in bypass now.
    expect(after?.posture).toBe("bypass")
    // The caller's ceiling is kept, unchanged by the agent's moves.
    expect(after?.postureCeiling).toBe("accept-edits")
    expect(after?.postureSource).toBe("agent")
    const warning = seen.find(ev => ev.type === "session:harness-warning")
    expect(warning).toMatchObject({ sessionId: desc.id })
    expect(JSON.stringify(warning)).toMatch(/bypass/)
    expect(JSON.stringify(warning)).toMatch(/accept-edits/)
    reg.shutdown()
  })

  it("a narrowing or equal agent switch raises no warning", async () => {
    const { reg, desc, seen } = setup(
      [[{ kind: "mode-changed", modeId: "plan", previousModeId: "acceptEdits", cause: "agent" }]],
      { posture: "accept-edits" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("plan")
    expect(seen.find(ev => ev.type === "session:harness-warning")).toBeUndefined()
    reg.shutdown()
  })

  it("a later caller agent_set_posture resets the ceiling to the caller's new pick", async () => {
    const { reg, desc } = setup(
      [[{ kind: "mode-changed", modeId: "plan", previousModeId: "acceptEdits", cause: "agent" }]],
      { posture: "accept-edits" },
      {
        availableModes: [mode("default"), mode("plan"), mode("bypassPermissions")],
        async setSessionMode(modeId: string) {
          return { applied: true, modeId }
        },
      },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.postureSource).toBe("agent")
    await reg.setPosture(desc.id, "bypass")
    const after = reg.get(desc.id)
    expect(after?.posture).toBe("bypass")
    expect(after?.postureSource).toBeUndefined()
    expect(after?.postureCeiling).toBeUndefined()
    reg.shutdown()
  })
})

describe("restart keeps the current posture", () => {
  function capturingResolver(): { resolver: AgentAdapterResolver; postures: unknown[] } {
    const postures: unknown[] = []
    const resolver: AgentAdapterResolver = async () => ({
      startSession: async (o: { posture?: unknown }) => {
        postures.push(o.posture)
        return scriptedSession([])
      },
      commandPreview: "mock-adapter",
    })
    return { resolver, postures }
  }

  it("a restart after the agent left plan starts in the agent's current posture", async () => {
    const { reg, desc } = setup(
      [[{ kind: "mode-changed", modeId: "default", previousModeId: "plan", cause: "agent" }]],
      { posture: "plan" },
    )
    await reg.sendPrompt(desc.id, "go")
    const { resolver, postures } = capturingResolver()
    const restarted = await restartAgentSession(reg, resolver, reg.get(desc.id)!, {
      forceAgentResume: true,
    })
    expect(postures).toEqual(["default"])
    expect(restarted.desc.posture).toBe("default")
    reg.shutdown()
  })

  it("a restart after the agent widened past the ceiling starts at the caller's ceiling", async () => {
    const { reg, desc } = setup(
      [[{ kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "plan", cause: "agent" }]],
      { posture: "accept-edits" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("bypass")
    const { resolver, postures } = capturingResolver()
    const restarted = await restartAgentSession(reg, resolver, reg.get(desc.id)!, {
      forceAgentResume: true,
    })
    expect(postures).toEqual(["accept-edits"])
    expect(restarted.desc.posture).toBe("accept-edits")
    reg.shutdown()
  })

  it("an agent that widened a session spawned with no posture restarts with no posture (the adapter default)", async () => {
    const { reg, desc } = setup(
      [[{ kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "default", cause: "agent" }]],
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("bypass")
    const { resolver, postures } = capturingResolver()
    const restarted = await restartAgentSession(reg, resolver, reg.get(desc.id)!, {
      forceAgentResume: true,
    })
    expect(postures).toEqual([undefined])
    expect(restarted.desc.posture).toBeUndefined()
    reg.shutdown()
  })
})

describe("in-place revival clamps to the caller's ceiling", () => {
  it("an ended row revived in place after an agent widening is handed the ceiling and reconciles the descriptor", async () => {
    // The registry decides the revival posture and hands it to the resume
    // hook as `posture`; index.ts's hook forwards exactly that value to
    // `startSession`, so this records what the adapter is started in.
    const resumePostures: Array<Posture | undefined> = []
    const resumeAgent: AgentSessionResumer = async input => {
      resumePostures.push(input.posture)
      return scriptedSession([])
    }
    const { reg, desc, postureEvents } = setup(
      [[{ kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "plan", cause: "agent" }]],
      { posture: "accept-edits" },
      {},
      { resumeAgent },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("bypass")
    // End the row the way `session_restart`'s in-place branch expects to find
    // it: dead, resumable, binding cleared.
    expect(reg.reapIdle(desc.id)).toBe(true)

    const revived = await tryRestartInPlace(reg, reg.get(desc.id)!)
    expect(revived?.id).toBe(desc.id)
    expect(resumePostures).toEqual(["accept-edits"])
    expect(revived?.posture).toBe("accept-edits")
    expect(revived?.postureCeiling).toBe("accept-edits")
    expect(revived?.postureSource).toBe("agent")
    // The clamp is announced, so the chip and session list refresh.
    expect(postureEvents().map(ev => ev.value)).toEqual(["bypass", "accept-edits"])
    reg.shutdown()
  })

  it("a revival within the ceiling hands the current posture and emits nothing new", async () => {
    const resumePostures: Array<Posture | undefined> = []
    const resumeAgent: AgentSessionResumer = async input => {
      resumePostures.push(input.posture)
      return scriptedSession([])
    }
    const { reg, desc, postureEvents } = setup(
      [[{ kind: "mode-changed", modeId: "default", previousModeId: "plan", cause: "agent" }]],
      { posture: "plan" },
      {},
      { resumeAgent },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.reapIdle(desc.id)).toBe(true)
    const revived = await tryRestartInPlace(reg, reg.get(desc.id)!)
    expect(resumePostures).toEqual(["default"])
    expect(revived?.posture).toBe("default")
    expect(postureEvents()).toHaveLength(1)
    reg.shutdown()
  })
})

describe("a restart carries the caller's ceiling", () => {
  it("a non-clamping new-id restart keeps the ceiling, so returning to the caller-allowed mode raises no warning", async () => {
    const { reg, desc, seen } = setup(
      [[{ kind: "mode-changed", modeId: "plan", previousModeId: "acceptEdits", cause: "agent" }]],
      { posture: "accept-edits" },
    )
    await reg.sendPrompt(desc.id, "go")
    expect(reg.get(desc.id)?.posture).toBe("plan")

    const postures: unknown[] = []
    const resolver: AgentAdapterResolver = async () => ({
      startSession: async (o: { posture?: unknown }) => {
        postures.push(o.posture)
        return scriptedSession([
          [{ kind: "mode-changed", modeId: "acceptEdits", previousModeId: "plan", cause: "agent" }],
        ])
      },
      commandPreview: "mock-adapter",
    })
    const restarted = await restartAgentSession(reg, resolver, reg.get(desc.id)!, {
      forceAgentResume: true,
    })
    expect(postures).toEqual(["plan"])
    expect(restarted.desc.posture).toBe("plan")
    expect(restarted.desc.postureCeiling).toBe("accept-edits")
    expect(restarted.desc.postureSource).toBe("agent")

    await reg.sendPrompt(restarted.desc.id, "go")
    const after = reg.get(restarted.desc.id)
    expect(after?.posture).toBe("accept-edits")
    expect(after?.postureCeiling).toBe("accept-edits")
    expect(seen.find(ev => ev.type === "session:harness-warning")).toBeUndefined()
    reg.shutdown()
  })
})

describe("the widening warning with no caller posture", () => {
  it("names the adapter default instead of rendering \"the caller's the adapter default\"", async () => {
    const { reg, desc, seen } = setup([
      [{ kind: "mode-changed", modeId: "bypassPermissions", previousModeId: "default", cause: "agent" }],
    ])
    await reg.sendPrompt(desc.id, "go")
    const warning = seen.find(ev => ev.type === "session:harness-warning") as
      | { warnings: string[] }
      | undefined
    expect(warning).toBeDefined()
    const text = warning!.warnings.join(" ")
    expect(text).not.toContain("caller's the adapter default")
    expect(text).toContain("wider than the adapter default; a restart starts at the adapter default")
    reg.shutdown()
  })
})
