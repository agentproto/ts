import { describe, it, expect, vi } from "vitest"
import { createArmSessionControls } from "../session-controls.js"
import type { AgentCliClient, AgentCliHandle } from "../types.js"

/**
 * `createArmSessionControls` used STANDALONE — the case that motivated
 * exporting it. A host whose child process lives somewhere
 * `createAgentCliRuntime` can't spawn it (an e2b sandbox, a remote daemon
 * behind a WS tunnel) builds its own `AgentCliRuntimeSession` around the
 * same arm, and needs the six live-session members without re-deriving
 * them. The behaviour reached through `createAgentCliRuntime` is already
 * covered by `define-agent-cli-set-model.test.ts` and
 * `define-agent-cli-capability-read-surface.test.ts`; this pins the direct
 * entry point, with no spawn anywhere in sight.
 */

function armWith(partial: Partial<AgentCliClient> = {}): AgentCliClient {
  return {
    async connect() {},
    async send() {},
    async *events() {},
    async cancel() {},
    async close() {},
    ...partial,
  } as AgentCliClient
}

function defWith(models?: AgentCliHandle["models"]): AgentCliHandle {
  return { id: "fake", ...(models ? { models } : {}) } as AgentCliHandle
}

describe("createArmSessionControls", () => {
  it("snapshots the arm's read-surface, defaulting the absent ones", () => {
    const options = [{ id: "model", name: "Model" }]
    const modes = [{ id: "plan", name: "Plan" }]
    const controls = createArmSessionControls(
      armWith({
        availableConfigOptions: options,
        availableModes: modes,
        currentModeId: "plan",
      } as Partial<AgentCliClient>),
      defWith(),
    )

    expect(controls.availableConfigOptions).toEqual(options)
    expect(controls.availableModes).toEqual(modes)
    expect(controls.currentModeId).toBe("plan")
  })

  it("defaults an arm that models none of it to empty, not undefined", () => {
    const controls = createArmSessionControls(armWith(), defWith())

    expect(controls.availableConfigOptions).toEqual([])
    expect(controls.availableModes).toEqual([])
    expect(controls.currentModeId).toBeUndefined()
  })

  it("routes setModel through the arm's config surface by default", async () => {
    const setConfigOption = vi.fn(async () => ({ applied: true }))
    const controls = createArmSessionControls(
      armWith({ setConfigOption } as Partial<AgentCliClient>),
      defWith(),
    )

    await expect(controls.setModel("opus-5")).resolves.toEqual({
      applied: true,
      model: "opus-5",
    })
    expect(setConfigOption).toHaveBeenCalledWith("model", "opus-5")
  })

  it("reports requires-restart when the model is a spawn-time argv token", async () => {
    const setConfigOption = vi.fn(async () => ({ applied: true }))
    const controls = createArmSessionControls(
      armWith({ setConfigOption } as Partial<AgentCliClient>),
      defWith({ apply: "arg" }),
    )

    await expect(controls.setModel("opus-5")).resolves.toEqual({
      applied: false,
      reason: "requires-restart",
    })
    // No live surface exists for this strategy — don't ask the arm.
    expect(setConfigOption).not.toHaveBeenCalled()
  })

  it("reports not-supported for an arm with no mid-session config surface", async () => {
    const controls = createArmSessionControls(armWith(), defWith())

    await expect(controls.setModel("opus-5")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
    await expect(controls.setEffort("high")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
    await expect(controls.setSessionMode("plan")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
  })

  it("surfaces the agent's own rejection detail rather than throwing", async () => {
    const controls = createArmSessionControls(
      armWith({
        setConfigOption: vi.fn(async () => ({
          applied: false,
          reason: "unknown model id",
        })),
        setSessionMode: vi.fn(async () => ({
          applied: false,
          reason: "stale mode offer",
        })),
      } as Partial<AgentCliClient>),
      defWith(),
    )

    await expect(controls.setModel("nope")).resolves.toEqual({
      applied: false,
      reason: "unknown model id",
    })
    await expect(controls.setSessionMode("nope")).resolves.toEqual({
      applied: false,
      reason: "stale mode offer",
    })
  })

  it("applies effort through the same config surface", async () => {
    const setConfigOption = vi.fn(async () => ({ applied: true }))
    const controls = createArmSessionControls(
      armWith({ setConfigOption } as Partial<AgentCliClient>),
      defWith(),
    )

    await expect(controls.setEffort("high")).resolves.toEqual({
      applied: true,
      effort: "high",
    })
    expect(setConfigOption).toHaveBeenCalledWith("effort", "high")
  })
})
