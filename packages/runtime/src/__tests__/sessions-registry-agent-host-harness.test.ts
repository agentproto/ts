/**
 * `SessionsRegistryAgentHost.spawn` — AIP-15 P2 harness pinning.
 *
 * The host (non-sandbox) branch threads `harness.model`/`harness.effort`
 * straight onto `resolved.startSession()`'s own fields, folds `harness.skills`
 * into the adapter's declared `skills` option (same mechanism
 * `spawn-defaults.ts`'s `normalizeSkillsOption` uses for a full `agent_start`
 * spawn), and — since this simplified path never composes an
 * orchestrator/tool-policy surface for ANY step, harness or not — emits a
 * `session:harness-warning` event rather than silently pretending
 * `harness.role`/`harness.tools` took hold. The sandbox branch instead routes
 * `model`/`effort`/`role`/`skills` straight into `spawnAgentSession`'s own
 * top-level fields, which already resolve role and fold skills for real.
 */

import { describe, it, expect, vi } from "vitest"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { AgentAdapterResolver } from "../http-server.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeFixture(declaredOptions?: readonly { id: string; type: "boolean" | "integer" | "string" | "enum" }[]) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession,
    commandPreview: "mock-adapter",
    ...(declaredOptions ? { declaredOptions } : {}),
  }))
  const events: SessionEvent[] = []
  sessionEvents.onAny((ev) => events.push(ev))
  return { registry, sessionEvents, resolveAgentAdapter, startSession, events }
}

describe("SessionsRegistryAgentHost.spawn — harness (host branch)", () => {
  it("threads harness.model and harness.effort onto resolved.startSession()", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await host.spawn("mock", {
      cwd: "/tmp",
      stepId: "s1",
      harness: { model: "opus", effort: "high" },
    })

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opus", effort: "high" }),
    )
  })

  it("folds harness.skills into options.skills when the adapter declares a string skills option", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture([
      { id: "skills", type: "string" },
    ])
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await host.spawn("mock", {
      cwd: "/tmp",
      stepId: "s1",
      harness: { skills: ["review", "triage"] },
    })

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ options: { skills: "review,triage" } }),
    )
  })

  it("drops harness.skills silently when the adapter declares no skills option (documented no-op)", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture([])
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await host.spawn("mock", { cwd: "/tmp", stepId: "s1", harness: { skills: ["review"] } })

    const call = startSession.mock.calls[0]![0] as { options?: Record<string, unknown> }
    expect(call.options?.skills).toBeUndefined()
  })

  it("emits session:harness-warning (never silently ignores) when harness.tools is set", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, events } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const id = await host.spawn("mock", { cwd: "/tmp", stepId: "s1", harness: { tools: ["read"] } })

    const warning = events.find((e) => e.type === "session:harness-warning")
    expect(warning).toBeDefined()
    expect(warning).toMatchObject({ sessionId: id, label: "s1" })
    expect((warning as { warnings: string[] }).warnings.join(" ")).toMatch(/harness\.tools/)
  })

  it("emits session:harness-warning when harness.role is set — this path applies no role-based tool policy", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, events } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await host.spawn("mock", { cwd: "/tmp", stepId: "s1", harness: { role: "supervisor" } })

    const warning = events.find((e) => e.type === "session:harness-warning")
    expect(warning).toBeDefined()
    expect((warning as { warnings: string[] }).warnings.join(" ")).toMatch(/harness\.role/)
  })

  it("emits no warning when harness carries only supported fields", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, events } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await host.spawn("mock", { cwd: "/tmp", stepId: "s1", harness: { model: "opus" } })

    expect(events.find((e) => e.type === "session:harness-warning")).toBeUndefined()
  })
})

describe("SessionsRegistryAgentHost.spawn — harness (sandbox branch)", () => {
  it("threads model/effort/role/skills into spawnAgentSession's own fields", async () => {
    const spawnAgentSessionMock = vi.fn(async () => ({
      ok: true as const,
      descriptor: {
        id: "sess_sandbox",
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
      },
    }))
    vi.doMock("../session-spawn.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../session-spawn.js")>()
      return { ...actual, spawnAgentSession: spawnAgentSessionMock }
    })
    vi.resetModules()
    const { SessionsRegistryAgentHost: MockedHost } = await import("../sessions-registry-agent-host.js")
    const { createSessionsRegistry: mockedCreateRegistry } = await import("../sessions.js")
    const { createSessionEventBus: mockedCreateBus } = await import("../session-event-bus.js")

    const sessionEvents = mockedCreateBus()
    const registry = mockedCreateRegistry({ sessionEvents, persist: false })
    const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
      startSession: vi.fn(async () => fakeAgentSession()),
    }))
    const resolveSandboxProvider = vi.fn()
    const host = new MockedHost(registry, sessionEvents, resolveAgentAdapter, { resolveSandboxProvider })

    await host.spawn("claude-sdk", {
      cwd: "/tmp",
      stepId: "s1",
      sandbox: "e2b",
      harness: { model: "opus", effort: "high", role: "executor", skills: ["review"] },
    })

    expect(spawnAgentSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "opus",
        effort: "high",
        role: "executor",
        skills: ["review"],
      }),
    )
    vi.doUnmock("../session-spawn.js")
    vi.resetModules()
  })
})
