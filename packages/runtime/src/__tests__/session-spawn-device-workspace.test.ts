/**
 * Device-spawn repo-identity + target-registry discipline (BOOTSTRAP P8 /
 * agentproto/ts #1647). Field-verified silent-wrong-landing evidence: a
 * `device:<fp>` spawn omitting BOTH `cwd` and `workspaceSlug` resolved cwd
 * from the TARGET daemon's ACTIVE workspace (`C:\Users\jerem`) — wrong
 * files, wrong AGENTS.md, wrong git repo, no error anywhere — and an
 * unknown workspaceSlug through the bridge should have failed loudly, not
 * silently fallen through to whatever the target had active.
 *
 * Covered here:
 *   - controller side (`spawnAgentSession`): a device spawn naming neither
 *     field is refused (`device_spawn_requires_repo_identity`) before any
 *     resolution; with an explicit cwd or workspaceSlug today's flow is kept
 *     (cwd forwarded verbatim; slug forwarded over the bridge with
 *     `deviceBridge: true` so the target resolves it against ITS registry).
 *   - `gatewayAsAdapterHint` (#1647's `adapter_not_found` half): a route-like
 *     slug (`opencode-go`) gets an actionable refusal naming the corrective
 *     adapter + model/route usage; unknown slugs keep the generic message.
 *   - local spawns untouched: root active-workspace fallback still works,
 *     a caller-supplied `deviceBridge` is inert on a local arrow, and the
 *     e2b (non-device) provider forwards neither marker field.
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
      sandboxId: "sbx_fake_device_target",
      start: startMock,
      prompt: vi.fn(async () => {}),
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps, type SpawnAgentSessionInput } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { gatewayAsAdapterHint } from "../adapter-slug-hint.js"
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

function makeResolver(startSession: (...args: any[]) => Promise<AgentSessionLike>): AgentAdapterResolver {
  return async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
}

describe("gatewayAsAdapterHint (issue #1647 — actionable adapter_not_found)", () => {
  it("names the route + the corrective model/route usage for opencode-go", () => {
    const hint = gatewayAsAdapterHint("opencode-go")
    expect(hint).toBeDefined()
    expect(hint!).toContain("opencode-go")
    expect(hint!).toContain("model:")
    expect(hint!).toContain("route:")
    expect(hint!).toContain("not an adapter")
  })

  it("hints the other known gateway ids too", () => {
    expect(gatewayAsAdapterHint("openrouter")).toBeDefined()
    expect(gatewayAsAdapterHint("moonshot")).toBeDefined()
  })

  it("is undefined for a genuinely-unknown slug (the generic message stands)", () => {
    expect(gatewayAsAdapterHint("totally-made-up-adapter")).toBeUndefined()
  })

  it("agent_start surfaces the hint on adapter_not_found", async () => {
    const registry = createSessionsRegistry({ persist: false })
    try {
      const deps: SpawnAgentSessionDeps = {
        registry,
        resolveAgentAdapter: (async () => null) as unknown as AgentAdapterResolver,
      }
      const result = await spawnAgentSession(deps, { adapter: "opencode-go", cwd: "/tmp" })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected failure")
      expect(result.code).toBe("adapter_not_found")
      expect(result.message).toContain("opencode")
      expect(result.message).toContain("model:")
      expect(result.message).toContain("route:")
      // The generic "install it" advice must NOT.ImageLayout fire on top of the hint.
      expect(result.message).not.toContain("agentproto install opencode-go")
    } finally {
      registry.shutdown()
    }
  })
})

function makeDeviceDeps(
  registry: SessionsRegistry,
  deviceSlug = "device:win-host",
  omitCwdWhenImplicit = true,
): SpawnAgentSessionDeps {
  return {
    registry,
    resolveAgentAdapter: (async () => null) as unknown as AgentAdapterResolver,
    resolveSandboxProvider: async (slug: string) => {
      if (slug !== deviceSlug) return null
      return {
        provider: {
          async boot() {
            return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_fake", async stop() {} }
          },
        },
        slug: deviceSlug,
        name: deviceSlug.slice("device:".length),
        version: "builtin",
        description: "test double",
        requiresSetup: false,
        capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
        omitCwdWhenImplicit,
        async check() {
          return true
        },
      }
    },
  }
}

describe("device spawn repo identity (issue #1647)", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-identity-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockReset()
    startMock.mockResolvedValue({ id: "remote_sess_1" })
    // An ACTIVE controller workspace resolving to a controller path — the
    // whole point is that a device spawn must never silently ride it.
    wsConfigState.value = {
      version: 1,
      active: "controller-repo",
      workspaces: [
        {
          slug: "controller-repo",
          path: "/Users/op/controller-repo",
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

  it("device spawn with NEITHER cwd nor workspaceSlug → device_spawn_requires_repo_identity; message names both fields", async () => {
    const result = await spawnAgentSession(makeDeviceDeps(registry), {
      adapter: "opencode",
      sandbox: "device:win-host",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected refusal")
    expect(result.code).toBe("device_spawn_requires_repo_identity")
    expect(result.message).toContain("`cwd`")
    expect(result.message).toContain("`workspaceSlug`")
    // Refused before anything booted.
    expect(startMock).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("the guard fires for the inline-spec device form too", async () => {
    const result = await spawnAgentSession(makeDeviceDeps(registry), {
      adapter: "opencode",
      sandbox: { provider: "device:win-host", config: {} },
      prompt: "run locally-named ask",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected refusal")
    expect(result.code).toBe("device_spawn_requires_repo_identity")
    expect(startMock).not.toHaveBeenCalled()
  })

  it("device spawn with an EXPLICIT cwd keeps today's validated path (cwd forwarded verbatim)", async () => {
    const result = await spawnAgentSession(makeDeviceDeps(registry), {
      adapter: "opencode",
      cwd: "/explicit/target/path",
      sandbox: "device:win-host",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.cwd).toBe("/explicit/target/path")
  })

  it("device spawn with an explicit workspaceSlug forwards the slug + deviceBridge over the bridge (target resolves)", async () => {
    const result = await spawnAgentSession(makeDeviceDeps(registry), {
      adapter: "opencode",
      workspaceSlug: "wanted-target-ws",
      sandbox: "device:win-host",
    })
    if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.workspaceSlug).toBe("wanted-target-ws")
    expect(args.deviceBridge).toBe(true)
    // The controller's cwd (even its OWN active-workspace fallback path) is
    // never forwarded for a slug-only device spawn.
    expect("cwd" in args).toBe(false)
  })

  it("e2b (non-device) sandbox: neither marker field is forwarded — same-machine semantics untouched", async () => {
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: (async () => null) as unknown as AgentAdapterResolver,
      resolveSandboxProvider: async (slug: string) => {
        if (slug !== "e2b") return null
        return {
          provider: {
            async boot() {
              return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_e2b", async stop() {} }
            },
          },
          slug: "e2b",
          name: "e2b",
          version: "builtin",
          description: "test double",
          requiresSetup: false,
          capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
          async check() {
            return true
          },
        }
      },
    }
    const result = await spawnAgentSession(deps, {
      adapter: "opencode",
      workspaceSlug: "controller-repo",
      sandbox: "e2b",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.deviceBridge).toBeUndefined()
    expect(args.workspaceSlug).toBeUndefined()
    expect(args.cwd).toBe("/Users/op/controller-repo")
  })
})

describe("local spawn semantics unchanged (issue #1647 back-compat)", () => {
  let registry: SessionsRegistry

  beforeEach(() => {
    registry = createSessionsRegistry({ persist: false })
    wsConfigState.value = {
      version: 1,
      active: "controller-repo",
      workspaces: [
        {
          slug: "controller-repo",
          path: "/Users/op/controller-repo",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
  })

  afterEach(() => {
    registry.shutdown()
  })

  function localDeps(startSession?: (...args: any[]) => Promise<AgentSessionLike>): SpawnAgentSessionDeps {
    return {
      registry,
      resolveAgentAdapter: makeResolver(startSession ?? (async () => fakeAgentSession())),
    }
  }

  it("local ROOT spawn without cwd still resolves the active workspace", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const result = await spawnAgentSession(localDeps(startSession), { adapter: "mock" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.cwd).toBe("/Users/op/controller-repo")
  })

  it("local spawn with unknown workspaceSlug + no cwd still errors with no_cwd (NOT the device message)", async () => {
    const result = await spawnAgentSession(localDeps(), {
      adapter: "mock",
      workspaceSlug: "no-such-workspace",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("no_cwd")
    expect(result.message).not.toContain("device-bridge")
  })

  it("a caller-supplied deviceBridge on an HTTP-style body is NOT accepted (drops at the mapper)", async () => {
    const { buildSpawnSessionHttpArgs } = await import("../http-server.js")
    const args = buildSpawnSessionHttpArgs(
      { adapter: "mock", cwd: "/tmp", deviceBridge: true } as Record<string, unknown>,
      "mock",
    ) as unknown as SpawnAgentSessionInput
    expect(args.deviceBridge).toBeUndefined()
  })

  it("a caller-supplied deviceBridge on a local spawn is inert: active-workspace resolution unaffected", async () => {
    const result = await spawnAgentSession(localDeps(), {
      adapter: "mock",
      deviceBridge: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.cwd).toBe("/Users/op/controller-repo")
  })

  it("TARGET side — unknown workspaceSlug on a deviceBridge spawn fails loudly: slug + known slugs named, never the active workspace", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const result = await spawnAgentSession(localDeps(startSession), {
      adapter: "mock",
      workspaceSlug: "win-codex",
      deviceBridge: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("device_bridge_workspace_unknown")
    expect(result.message).toContain("win-codex")
    expect(result.message).toContain("controller-repo")
    expect(result.details?.knownWorkspaceSlugs).toEqual(["controller-repo"])
    // Nothing was registered — the bridge spawn never silently landed.
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("TARGET side — a KNOWN workspaceSlug on a deviceBridge spawn resolves against this daemon's registry as-normal", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const result = await spawnAgentSession(localDeps(startSession), {
      adapter: "mock",
      workspaceSlug: "controller-repo",
      deviceBridge: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.cwd).toBe("/Users/op/controller-repo")
    expect(result.descriptor.workspaceSlug).toBe("controller-repo")
  })

  it("the marker rides the MCP schema (controller bridge → target agent_start) and survives zod", async () => {
    const { agentStartInputSchema } = await import("../agent-start-schema.js")
    const parsed = agentStartInputSchema.parse({ adapter: "opencode", workspaceSlug: "x", deviceBridge: true })
    expect(parsed.deviceBridge).toBe(true)
    expect(parsed.workspaceSlug).toBe("x")
  })
})
