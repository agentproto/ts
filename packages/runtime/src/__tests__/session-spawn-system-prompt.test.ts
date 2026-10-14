/**
 * `spawnAgentSession({ appendSystemPrompt })`: the AGENT.md text rides the
 * adapter's declared system-prompt channel (`supportsSystemPrompt`), and an
 * adapter without one gets it as the first prompt's prefix + a warning —
 * never a silent drop. The text is recorded on the descriptor either way so
 * restart / fresh-continuation can re-apply it.
 */

import { describe, it, expect, vi } from "vitest"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

import { spawnAgentSession } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const TEXT = "You are a trip scout.\n\nHard rules — these MUST be followed:\n- Never invent a sourceUrl"

function setup(supportsSystemPrompt: boolean) {
  const prompts: string[] = []
  const session: AgentSessionLike = {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(prompt: unknown): AsyncIterable<AgentStreamEvent> {
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt))
    },
    async cancel() {},
    async close() {},
  }
  const startSession = vi.fn(async (_opts: { appendSystemPrompt?: string }) => session)
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter (agent)",
    ...(supportsSystemPrompt ? { supportsSystemPrompt: true } : {}),
  })
  const registry = createSessionsRegistry({ persist: false })
  return { prompts, startSession, deps: { registry, resolveAgentAdapter } }
}

describe("spawnAgentSession — appendSystemPrompt", () => {
  it("a channel adapter gets the text on startSession, not in the prompt", async () => {
    const { prompts, startSession, deps } = setup(true)
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      prompt: "Zone: Luberon.",
      appendSystemPrompt: TEXT,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(startSession.mock.calls[0]![0].appendSystemPrompt).toBe(TEXT)
    await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0))
    expect(prompts[0]).toContain("Zone: Luberon.")
    expect(prompts[0]).not.toContain("You are a trip scout.")
    expect((result.warnings ?? []).join("\n")).not.toMatch(/system-prompt text not delivered/)
    expect(result.descriptor.appendSystemPrompt).toBe(TEXT)
  })

  it("an adapter without a channel gets it as the first prompt's prefix, with a warning", async () => {
    const { prompts, startSession, deps } = setup(false)
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      prompt: "Zone: Luberon.",
      appendSystemPrompt: TEXT,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(startSession.mock.calls[0]![0].appendSystemPrompt).toBeUndefined()
    await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0))
    expect(prompts[0]!.indexOf("You are a trip scout.")).toBeGreaterThanOrEqual(0)
    expect(prompts[0]!.indexOf("You are a trip scout.")).toBeLessThan(prompts[0]!.indexOf("Zone: Luberon."))
    expect((result.warnings ?? []).join("\n")).toMatch(
      /system-prompt text not delivered.*declares no manifest systemPrompt channel.*first prompt's prefix/,
    )
    expect(result.descriptor.appendSystemPrompt).toBe(TEXT)
  })
})
