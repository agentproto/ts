/**
 * `SessionsRegistryAgentHost.spawn` — sandbox branch (fail-loud contract).
 *
 * A workflow `AgentStep.sandbox` spawn MUST either run in the requested
 * sandbox or throw — never silently fall back to a host spawn. These tests
 * pin the three failure edges:
 *   1. an invalid inline spec fails schema validation BEFORE any boot, and
 *      the local adapter path is never consulted;
 *   2. a provider slug with no `resolveSandboxProvider` wired surfaces the
 *      wrapped `sandbox_provider_not_found` error, again with no host spawn;
 *   3. the happy host-spawn path (no `sandbox`) is untouched — the adapter
 *      resolver IS consulted there.
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
  const resolveAdapterSpy = vi.fn(async () => ({
    startSession,
    commandPreview: "mock-adapter",
  }))
  const resolveAgentAdapter: AgentAdapterResolver = resolveAdapterSpy
  return { registry, sessionEvents, resolveAgentAdapter, resolveAdapterSpy, startSession }
}

describe("SessionsRegistryAgentHost.spawn — sandbox branch", () => {
  it("throws on an invalid inline sandbox spec (strict AIP-36 schema) and never host-spawns", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, resolveAdapterSpy } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await expect(
      host.spawn("claude-sdk", {
        cwd: "/tmp",
        stepId: "review",
        // `bogusField` violates the schema's `.strict()` — must fail
        // validation before any provider resolution or boot.
        sandbox: { provider: "e2b", bogusField: true },
      }),
    ).rejects.toThrow(/sandbox spec invalid/)

    // Fail-loud means fail EMPTY: no local adapter consulted, no session
    // registered, no label mapped.
    expect(resolveAdapterSpy).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
    expect(host.resolveByLabel("review")).toBeUndefined()
  })

  it("throws the wrapped sandbox_provider_not_found error when no resolver is wired — no silent host spawn", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, resolveAdapterSpy, startSession } =
      makeFixture()
    // No `resolveSandboxProvider` in opts — the daemon-side wiring is absent.
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    await expect(
      host.spawn("claude-sdk", { cwd: "/tmp", stepId: "review", sandbox: "e2b" }),
    ).rejects.toThrow(/sandbox spawn failed \(sandbox_provider_not_found\)/)

    // The sandbox branch skips local adapter resolution entirely, and the
    // failure must not leak a host session.
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
    expect(host.resolveByLabel("review")).toBeUndefined()
  })

  it("valid inline spec still fails loud (not host-spawn) when the provider can't resolve", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, startSession } = makeFixture()
    // Resolver wired but unable to resolve the slug — the "supported but not
    // installed" shape (`makeSandboxResolver` wraps unknown slugs to null).
    const resolveSandboxProvider = vi.fn(async () => null)
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
      resolveSandboxProvider,
    })

    await expect(
      host.spawn("claude-sdk", {
        cwd: "/tmp",
        sandbox: { provider: "e2b", config: {}, env: { passthrough: [] } },
      }),
    ).rejects.toThrow(/sandbox spawn failed \(sandbox_provider_not_found\)/)

    expect(resolveSandboxProvider).toHaveBeenCalledWith("e2b")
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("host spawn path (no sandbox) is unchanged — resolves the adapter locally", async () => {
    const { registry, sessionEvents, resolveAgentAdapter, resolveAdapterSpy } = makeFixture()
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const id = await host.spawn("mock", { cwd: "/tmp", stepId: "s1" })

    expect(resolveAdapterSpy).toHaveBeenCalledWith("mock")
    expect(registry.list()).toHaveLength(1)
    expect(host.resolveByLabel("s1")).toBe(id)
  })
})
