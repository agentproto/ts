/**
 * PR3 — reconnect/reuse an existing sandbox + AIP-36 lifecycle pause. Same
 * "real wire path" style as `agent-start-sandbox.test.ts` (PR2): a fake
 * `SandboxProvider` wraps a real in-process daemon (`createGateway`), and
 * `spawnAgentSession` drives it exactly like a real box — the only thing
 * under test here is the reuse (`connect` vs `boot`) branch and the
 * pause-vs-kill teardown decision, not the proxy's wire mechanics (already
 * covered by PR2's suite).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** Pull the text out of whatever `runAgentTurn` wraps a string prompt into. */
function extractText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

/** Fake CLI adapter for the BOX's own `agent_start` — echoes the prompt back
 *  as a single text-delta, then a normal turn-end. */
function makeFakeCliResolver(receivedPrompts: string[]): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      async startSession(): Promise<AgentSessionLike> {
        return {
          sessionId: "remote_sess_1",
          async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
            const text = extractText(message)
            receivedPrompts.push(text)
            yield { kind: "text-delta", text: `echo: ${text}` }
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

/**
 * Boot a real in-process daemon (the "box") and wrap it as a `SandboxProvider`
 * that supports BOTH `boot()` and `connect()` (+ `pause()`), spying on each,
 * so tests can assert which path fired without booting a second real daemon
 * — a `connect()` in these tests reconnects to the SAME live gateway a prior
 * `boot()` would have produced, exactly like e2b reconnecting to the same box.
 */
async function bootFakeReconnectableBox(receivedPrompts: string[]): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
  bootSpy: ReturnType<typeof vi.fn>
  connectSpy: ReturnType<typeof vi.fn>
  stopSpy: ReturnType<typeof vi.fn>
  pauseSpy: ReturnType<typeof vi.fn>
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-reconnect-test-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    resolveAgentAdapter: makeFakeCliResolver(receivedPrompts),
  })
  const stopSpy = vi.fn(async () => {
    await gateway.stop()
  })
  // A real e2b pause snapshots the box without killing it — the fake daemon
  // just stays up so a same-test round-trip after "pause" still works.
  const pauseSpy = vi.fn(async () => {})
  const bootSpy = vi.fn(async () => ({
    mcpUrl: `${gateway.url}/mcp`,
    sandboxId: "sbx_fresh",
    stop: stopSpy,
    pause: pauseSpy,
  }))
  const connectSpy = vi.fn(async (sandboxId: string) => ({
    mcpUrl: `${gateway.url}/mcp`,
    sandboxId,
    stop: stopSpy,
    pause: pauseSpy,
  }))
  const provider: SandboxProvider = { boot: bootSpy, connect: connectSpy }
  return { provider, gateway, workspace, bootSpy, connectSpy, stopSpy, pauseSpy }
}

describe("agent_start sandbox — reconnect/reuse + lifecycle pause", () => {
  let receivedPrompts: string[]
  let box: Awaited<ReturnType<typeof bootFakeReconnectableBox>>
  let registry: SessionsRegistry
  let workspace: string
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    receivedPrompts = []
    box = await bootFakeReconnectableBox(receivedPrompts)
    registry = createSessionsRegistry({ persist: false })
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-reconnect-host-"))

    const resolveSandboxProviderSpy = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return {
        provider: box.provider,
        slug: "fake",
        name: "Fake",
        version: "test",
        description: "test double supporting boot + connect + pause",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: true, readOnly: false },
        async check() {
          return true
        },
      }
    })

    deps = {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: resolveSandboxProviderSpy,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("sandbox.reuse calls provider.connect (not boot), and surfaces the reused sandboxId", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, reuse: "sbx_123" },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(box.connectSpy).toHaveBeenCalledWith(
      "sbx_123",
      expect.objectContaining({ provider: "fake", reuse: "sbx_123" }),
      expect.anything(),
    )
    expect(box.bootSpy).not.toHaveBeenCalled()
    expect(result.descriptor.remote).toBe(true)
    expect(result.descriptor.sandboxId).toBe("sbx_123")
  })

  it("reuse round-trips a prompt through the reconnected box", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, reuse: "sbx_123" },
      prompt: "hello again",
      wait: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0]).toContain("hello again")
    expect(result.output?.some(line => line.includes("echo: "))).toBe(true)
  })

  it("reuse defaults to PAUSE (not kill) on close, even with no explicit lifecycle block", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, reuse: "sbx_123" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    registry.kill(result.descriptor.id)
    await vi.waitFor(() => expect(box.pauseSpy).toHaveBeenCalledTimes(1))
    expect(box.stopSpy).not.toHaveBeenCalled()
    expect(registry.get(result.descriptor.id)?.sandboxTeardown).toBe("pause")
  })

  it("lifecycle.pause_after_idle pauses (not kills) on close, without reuse", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, lifecycle: { pause_after_idle: "idle-600" } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A fresh boot, not a reconnect — pause_after_idle alone drives the policy.
    expect(box.bootSpy).toHaveBeenCalledTimes(1)
    expect(box.connectSpy).not.toHaveBeenCalled()

    registry.kill(result.descriptor.id)
    await vi.waitFor(() => expect(box.pauseSpy).toHaveBeenCalledTimes(1))
    expect(box.stopSpy).not.toHaveBeenCalled()
  })

  it("a plain ephemeral spawn (no reuse, no lifecycle) still KILLS on close", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(registry.get(result.descriptor.id)?.sandboxTeardown).toBe("kill")

    registry.kill(result.descriptor.id)
    await vi.waitFor(() => expect(box.stopSpy).toHaveBeenCalledTimes(1))
    expect(box.pauseSpy).not.toHaveBeenCalled()
  })

  it("lifecycle.destroy_on always kills, even when reuse is set", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: {},
        reuse: "sbx_123",
        lifecycle: { destroy_on: "workspace-close" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    registry.kill(result.descriptor.id)
    await vi.waitFor(() => expect(box.stopSpy).toHaveBeenCalledTimes(1))
    expect(box.pauseSpy).not.toHaveBeenCalled()
  })

  it("returns sandbox_reconnect_failed (not sandbox_boot_failed) when the provider has no connect()", async () => {
    const bootOnlyProvider: SandboxProvider = {
      async boot() {
        throw new Error("boot should never be called for a reuse request")
      },
    }
    const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "boot-only") return null
      return {
        provider: bootOnlyProvider,
        slug: "boot-only",
        name: "Boot-only",
        version: "test",
        description: "no connect() at all",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
      }
    })

    const result = await spawnAgentSession(
      { ...deps, resolveSandboxProvider },
      {
        adapter: "fake-cli",
        cwd: workspace,
        sandbox: { provider: "boot-only", config: {}, reuse: "sbx_123" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_reconnect_failed")
    expect(result.message).toContain("no connect()")
  })

  it("returns sandbox_reconnect_failed when connect() itself throws", async () => {
    box.connectSpy.mockRejectedValueOnce(new Error("box is gone"))

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, reuse: "sbx_dead" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_reconnect_failed")
    expect(result.message).toContain("box is gone")
  })
})
