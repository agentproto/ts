/**
 * Posture on a sandbox (box-proxied) session. The host never applies a
 * posture itself for a sandbox spawn — the box's own daemon runs the adapter,
 * so `agent_start.posture` must ride the box's own `agent_start` (it used to
 * be dropped outright: no native mode, no spawn config, not even the advisory
 * preamble). The box then reports which postures its adapter enforces through
 * its isolated spawn config on its `agent_start` response
 * (`spawnEnforcedPostures`), and the host proxy surfaces exactly that — an
 * older box that reports nothing stays advisory on the host.
 *
 * Same `@agentproto/sandbox` mock shape as
 * `sandbox-omit-cwd-when-implicit.test.ts`, so the assertions can inspect the
 * exact args `bootSandboxAgentSession` hands `host.start()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

const startMock = vi.hoisted(() => vi.fn())
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => ({
      mcpUrl: "http://127.0.0.1:0/mcp",
      sandboxId: "sbx_fake_device",
      start: startMock,
      prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { buildSessionCapabilities } from "../session-capabilities.js"
import { boxSpawnEnforcedPosturesOf } from "../sandbox-agent-session-proxy.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

function makeDeps(registry: SessionsRegistry): SpawnAgentSessionDeps {
  const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
    if (slug !== "device:work-mac") return null
    return {
      provider: {
        async boot() {
          return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_fake_device", async stop() {} }
        },
      },
      slug: "device:work-mac",
      name: "work-mac",
      version: "builtin",
      description: "test double",
      requiresSetup: false,
      capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
      async check() {
        return true
      },
    }
  })
  return {
    registry,
    resolveAgentAdapter: vi.fn(async () => null),
    resolveSandboxProvider,
    loadDefaultsConfig: async () => undefined,
    loadRoleRegistry: async () => ({}),
  }
}

describe("sandbox spawn — posture forwarding", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-posture-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockReset()
    startMock.mockResolvedValue({ id: "remote_sess_1" })
    wsConfigState.value = {
      version: 1,
      active: "host-repo",
      workspaces: [
        {
          slug: "host-repo",
          path: "/Users/op/projects/some-repo",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("forwards the posture onto the box's own agent_start", async () => {
    const result = await spawnAgentSession(makeDeps(registry), {
      adapter: "opencode",
      workspaceSlug: "host-repo",
      sandbox: "device:work-mac",
      posture: "bypass",
    })
    expect(result.ok).toBe(true)
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.posture).toBe("bypass")
  })

  it("sends no posture field when the caller set none", async () => {
    await spawnAgentSession(makeDeps(registry), {
      adapter: "opencode",
      workspaceSlug: "host-repo",
      sandbox: "device:work-mac",
    })
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect("posture" in args).toBe(false)
  })

  it("reports spawn-config enforcement when the box says its adapter enforces the posture", async () => {
    startMock.mockResolvedValue({ id: "remote_sess_1", spawnEnforcedPostures: ["bypass", "accept-edits", "read-only"] })
    const result = await spawnAgentSession(makeDeps(registry), {
      adapter: "opencode",
      workspaceSlug: "host-repo",
      sandbox: "device:work-mac",
      posture: "bypass",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const desc = registry.get(result.descriptor.id)!
    expect(desc.spawnEnforcedPostures).toEqual(["bypass", "accept-edits", "read-only"])
    expect(buildSessionCapabilities(desc, 0).postureEnforcement).toBe("spawn-config")
  })

  it("stays advisory when the box reports nothing (older box daemon)", async () => {
    const result = await spawnAgentSession(makeDeps(registry), {
      adapter: "opencode",
      workspaceSlug: "host-repo",
      sandbox: "device:work-mac",
      posture: "bypass",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const desc = registry.get(result.descriptor.id)!
    expect(desc.spawnEnforcedPostures).toBeUndefined()
    expect(buildSessionCapabilities(desc, 0).postureEnforcement).toBe("prompt-advisory")
  })
})

describe("boxSpawnEnforcedPosturesOf", () => {
  it("keeps string entries and drops an empty or malformed report", () => {
    expect(boxSpawnEnforcedPosturesOf({ spawnEnforcedPostures: ["bypass", 3, ""] })).toEqual(["bypass"])
    expect(boxSpawnEnforcedPosturesOf({ spawnEnforcedPostures: [] })).toBeUndefined()
    expect(boxSpawnEnforcedPosturesOf({ spawnEnforcedPostures: "bypass" })).toBeUndefined()
    expect(boxSpawnEnforcedPosturesOf({ id: "x" })).toBeUndefined()
    expect(boxSpawnEnforcedPosturesOf(undefined)).toBeUndefined()
  })
})

describe("spawnAgent response", () => {
  it("carries the live session's spawn-enforced postures (what a proxying host reads)", () => {
    const registry = createSessionsRegistry({ persist: false })
    const agentSession: AgentSessionLike = {
      sessionId: "acp",
      // eslint-disable-next-line require-yield
      async *send() {
        return
      },
      async cancel() {},
      async close() {},
      spawnEnforcedPostures: ["bypass"],
    }
    const desc = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession, adapterSlug: "opencode" })
    expect(JSON.parse(JSON.stringify(desc)).spawnEnforcedPostures).toEqual(["bypass"])
    registry.shutdown()
  })
})
