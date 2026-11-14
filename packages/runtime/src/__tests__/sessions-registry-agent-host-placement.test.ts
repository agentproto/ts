/**
 * `SessionsRegistryAgentHost.spawn` — `placement` ladder + `turnRetry` forwarding.
 *
 * A workflow step's `placement` rides the sandbox branch into
 * `spawnAgentSession` (which validates and walks the ladder); its `turnRetry`
 * lands on the descriptor on the host branch too, so a runner-side review
 * session gets the same usage-limit fallback a boxed one does.
 */

import { describe, it, expect, vi } from "vitest"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
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

function makeFixture() {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession,
    commandPreview: "mock-adapter",
  }))
  return { registry, sessionEvents, resolveAgentAdapter, startSession }
}

describe("SessionsRegistryAgentHost.spawn — placement ladder", () => {
  it("routes a placement spawn through spawnAgentSession and never host-spawns when no rung resolves", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture()
    const resolveSandboxProvider = vi.fn(async () => null)
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
      resolveSandboxProvider,
    })

    await expect(
      host.spawn("opencode", {
        cwd: "/tmp",
        stepId: "review",
        placement: { ladder: [{ sandbox: "computer" }, { sandbox: "e2b" }] },
      }),
    ).rejects.toThrow(/sandbox spawn failed \(sandbox_placement_exhausted\)/)

    expect(resolveSandboxProvider).toHaveBeenCalledWith("computer")
    expect(resolveSandboxProvider).toHaveBeenCalledWith("e2b")
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses a spawn carrying both sandbox and placement (placement_invalid)", async () => {
    const { registry, sessionEvents, resolveAgentAdapter } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
      resolveSandboxProvider: vi.fn(async () => null),
    })

    await expect(
      host.spawn("opencode", {
        cwd: "/tmp",
        sandbox: "e2b",
        placement: { ladder: [{ sandbox: "e2b" }] },
      }),
    ).rejects.toThrow(/sandbox spawn failed \(placement_invalid\)/)
  })

  it("rejects a malformed ladder loudly instead of host-spawning", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
      resolveSandboxProvider: vi.fn(async () => null),
    })

    await expect(
      host.spawn("opencode", { cwd: "/tmp", placement: { ladder: [] } }),
    ).rejects.toThrow(/sandbox spawn failed \(placement_invalid\)/)
    expect(startSession).not.toHaveBeenCalled()
  })
})

describe("SessionsRegistryAgentHost.spawn — turnRetry", () => {
  it("resolves the policy onto a host-branch session's descriptor", async () => {
    const { registry, sessionEvents, resolveAgentAdapter } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const id = await host.spawn("mock", {
      cwd: "/tmp",
      stepId: "review",
      turnRetry: { on: ["usage-limit", "rate-limit"], fallback: [{ model: "opencode-go/deepseek-v4.1-flash" }] },
    })

    const policy = registry.get(id)?.turnRetry
    expect(policy?.on).toEqual(["usage-limit", "rate-limit"])
    expect(policy?.fallback).toEqual([{ model: "opencode-go/deepseek-v4.1-flash" }])
  })

  it("turnRetry: null is an explicit opt-out that matches nothing", async () => {
    const { registry, sessionEvents, resolveAgentAdapter } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const id = await host.spawn("mock", { cwd: "/tmp", stepId: "review", turnRetry: null })

    expect(registry.get(id)?.turnRetry?.on).toEqual([])
  })

  it("an omitted turnRetry leaves the descriptor without a policy", async () => {
    const { registry, sessionEvents, resolveAgentAdapter } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const id = await host.spawn("mock", { cwd: "/tmp", stepId: "review" })

    expect(registry.get(id)?.turnRetry).toBeUndefined()
  })

  it("a malformed turnRetry fails the step loudly before any session starts", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await expect(
      host.spawn("mock", { cwd: "/tmp", turnRetry: { on: ["not-a-class"] } }),
    ).rejects.toThrow(/turnRetry invalid/)
    expect(startSession).not.toHaveBeenCalled()
  })
})
