/**
 * `agent_start.sandbox` — boot box + proxy session (Option A). Exercises the
 * REAL wire path: a fake `SandboxProvider` boots an in-process daemon
 * (`createGateway`, the same function a `local` sandbox's `agentproto serve`
 * child process runs) with its own fake CLI adapter, and `spawnAgentSession`
 * (the host side, under test) connects to it exactly like a real box —
 * `createSandboxAgentSessionHost` → `HarnessClient` → `agent_start`/
 * `agent_prompt`/`session_monitor`/`agent_output`/`agent_kill` over real
 * HTTP. No mocking of the sandbox-agent-session-proxy internals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"

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
 *  as a single text-delta, then a normal turn-end. Records every prompt it
 *  receives so tests can assert the round-trip actually reached it. */
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

/** Boot a real in-process daemon (the "box") and wrap it as a `SandboxProvider`. */
async function bootFakeBox(receivedPrompts: string[]): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
  stopSpy: ReturnType<typeof vi.fn>
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-test-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    // Never write this fake box's rows into the developer's real
    // ~/.agentproto/ — the host-side registry below is already `persist: false`.
    // `persistPath` is pinned as well as `persist: false` because the
    // structured-transcript dir is derived from it, and that write is not
    // gated on `persist`.
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: makeFakeCliResolver(receivedPrompts),
  })
  const stopSpy = vi.fn(async () => {
    await gateway.stop()
  })
  const provider: SandboxProvider = {
    async boot() {
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId: "sbx_fake_1",
        stop: stopSpy,
      }
    },
  }
  return { provider, gateway, workspace, stopSpy }
}

describe("agent_start sandbox — boot box + proxy session", () => {
  let receivedPrompts: string[]
  let box: Awaited<ReturnType<typeof bootFakeBox>>
  let registry: SessionsRegistry
  let workspace: string
  let resolveSandboxProviderSpy: ReturnType<typeof vi.fn>
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    receivedPrompts = []
    box = await bootFakeBox(receivedPrompts)
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-host-"))
    // `transcriptDir` as well as `persist: false`: transcripts default to a
    // sibling of the (real) sessions.json path and are written regardless of
    // `persist`.
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })

    resolveSandboxProviderSpy = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return {
        provider: box.provider,
        slug: "fake",
        name: "Fake",
        version: "test",
        description: "test double booting an in-process daemon",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
      }
    })

    deps = {
      registry,
      // Never expected to be called for a sandboxed spawn — the sandbox
      // branch must short-circuit BEFORE local adapter resolution.
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: resolveSandboxProviderSpy,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    // maxRetries/retryDelay: the gateway's own fire-and-forget writes
    // (runtime.json, debounced sessions.json) can still be landing in
    // `box.workspace/.agentproto` right after `stop()` resolves — retry
    // past the transient ENOTEMPTY instead of flaking.
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("returns a local descriptor marked remote, with the box's sandboxId — no local resolveAgentAdapter call", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.remote).toBe(true)
    expect(result.descriptor.sandboxId).toBe("sbx_fake_1")
    expect(result.descriptor.pid).toBeNull()
    expect(deps.resolveAgentAdapter).not.toHaveBeenCalled()
  })

  it("round-trips a prompt through the proxy: agent_prompt/agent_output reach the box and come back", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      prompt: "hello from the host",
      wait: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The box's own fake adapter actually received the (role-composed) prompt.
    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0]).toContain("hello from the host")

    // The echoed reply flowed back through the proxy into the HOST's own
    // transcript/output — proving event-shape parity with the local path.
    expect(result.output?.some(line => line.includes("echo: "))).toBe(true)
  })

  it("agent_kill tears down the fake box, and the conversation stays readable after kill (amendment)", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      prompt: "please respond",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.descriptor.id

    const killed = registry.kill(id)
    expect(killed).toBe(true)
    // `registry.kill` fires `agentSession.close()` without awaiting it
    // (same fire-and-forget shape as a local adapter's close) — the
    // proxy's close() does a real `agent_kill` + daemon-close round-trip
    // to the box before calling `stop()`, so poll instead of asserting
    // synchronously.
    await vi.waitFor(() => expect(box.stopSpy).toHaveBeenCalledTimes(1))

    const desc = registry.get(id)
    expect(desc?.status).toBe("killed")

    // Transcript survives the (now-stopped) box — read via the HOST's own
    // registry, no round-trip to the box required. The composed prompt is
    // multi-line (role context + the literal prompt), so "please respond"
    // (the tail) and the "echo: " prefix (only on the FIRST resulting
    // line) are asserted separately rather than as one substring.
    const lines: string[] = []
    const unsub = registry.attach(id, line => lines.push(line))
    unsub?.()
    expect(lines.some(line => line.includes("please respond"))).toBe(true)
    expect(lines.some(line => line.includes("echo:"))).toBe(true)
  })

  it("rejects a sandboxed spawn past the caller scope's maxDepth BEFORE the sandbox provider is ever resolved", async () => {
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "deep-parent",
      depth: 3,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
    const result = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "fake-cli", cwd: workspace, sandbox: "fake" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("orchestrator_max_depth_exceeded")
    expect(resolveSandboxProviderSpy).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("returns sandbox_provider_not_found for an unknown slug, without booting anything", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "does-not-exist",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_provider_not_found")
    expect(registry.list()).toHaveLength(0)
  })

  it("returns sandbox_provider_not_found when no resolver is wired at all", async () => {
    const result = await spawnAgentSession(
      { ...deps, resolveSandboxProvider: undefined },
      { adapter: "fake-cli", cwd: workspace, sandbox: "fake" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_provider_not_found")
  })

  it("returns sandbox_boot_failed when the provider's boot() throws", async () => {
    const failingProvider: SandboxProvider = {
      async boot() {
        throw new Error("box never came up")
      },
    }
    const failingResolver = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake-fail") return null
      return {
        provider: failingProvider,
        slug: "fake-fail",
        name: "Fake (fails)",
        version: "test",
        description: "always fails to boot",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
      }
    })

    const result = await spawnAgentSession(
      { ...deps, resolveSandboxProvider: failingResolver },
      { adapter: "fake-cli", cwd: workspace, sandbox: "fake-fail" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_boot_failed")
    expect(result.message).toContain("box never came up")
  })

  it("returns sandbox_proxy_failed when the box's own agent_start rejects the adapter", async () => {
    const result = await spawnAgentSession(deps, {
      // "unknown-adapter" isn't registered on the box's fake resolver, so
      // the box's own agent_start returns adapter_not_found.
      adapter: "unknown-adapter",
      cwd: workspace,
      sandbox: "fake",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_proxy_failed")
  })
})
