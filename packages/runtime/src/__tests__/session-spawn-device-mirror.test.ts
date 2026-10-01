/**
 * BOOTSTRAP P7a — a `device:<fp|name>` sandbox spawn stamps the controller
 * descriptor with the HOST session id + the paired host's fingerprint
 * (issue #1637's `sess_305be17c` → `sess_cf318f00` id split). The mocked
 * `@agentproto/sandbox` host double follows
 * `session-spawn-device-agentsmd.test.ts`'s pattern; all remote-side
 * behaviour is scripted.
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

const ledgerMocks = vi.hoisted(() => ({
  recordBoot: vi.fn(),
  recordState: vi.fn(),
  recordOrigin: vi.fn(),
  recordLiveness: vi.fn(),
}))
vi.mock("../sandbox-ledger.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-ledger.js")>()
  return {
    ...actual,
    recordSandboxBoot: ledgerMocks.recordBoot,
    recordSandboxState: ledgerMocks.recordState,
    recordSandboxOrigin: ledgerMocks.recordOrigin,
    recordSandboxLiveness: ledgerMocks.recordLiveness,
  }
})

const startMock = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => ({
    id: "sess_remote_host",
    cwd: "C:\\Users\\win\\workspace",
  })),
)
/** `device` on the mocked HOST double — `undefined` flips the fallback test. */
const hostDeviceState = vi.hoisted(() => ({
  value: { fingerprint: "d5904a94aa8b46891cc30f9c23e9a9de" } as { fingerprint: string } | undefined,
}))
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
      ...(hostDeviceState.value ? { device: hostDeviceState.value } : {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

const CONTROLLER_CWD = "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts"

describe("spawnAgentSession — device sandbox stamps the hostSessionId mapping (P7a)", () => {
  let workspace: string
  let registry: SessionsRegistry

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-mirror-spawn-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockClear()
  })

  afterEach(async () => {
    registry.shutdown()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function makeDeps(): SpawnAgentSessionDeps {
    return {
      registry,
      resolveAgentAdapter: async () => null,
      resolveSandboxProvider: async (slug: string) => {
        if (slug !== "device:win-host") return null
        return {
          provider: {
            async boot() {
              return {
                mcpUrl: "http://127.0.0.1:0/mcp",
                sandboxId: "sbx_fake_device_target",
                async stop() {},
              }
            },
          },
          slug: "device:win-host",
          name: "win-host",
          version: "builtin",
          description: "test double",
          requiresSetup: false,
          capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
          omitCwdWhenImplicit: true,
          async check() {
            return true
          },
        }
      },
      loadDefaultsConfig: async () => undefined,
      resolveAgentsMd: async () => ({
        mode: "absent",
        contractLine: "DEVICE_CONTRACT_LINE_SUPPRESSED",
      }),
      resolveWorkspaceRules: async () => ({}),
      loadRoleRegistry: async () => ({}),
    }
  }

  it("the spawn result's descriptor carries hostSessionId + the resolved device fingerprint", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: CONTROLLER_CWD,
      sandbox: "device:win-host",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.hostSessionId).toBe("sess_remote_host")
    expect(result.descriptor.hostFingerprint).toBe("d5904a94aa8b46891cc30f9c23e9a9de")
    // …and the registry's stored descriptor too (the read paths read THAT).
    const stored = registry.get(result.descriptor.id)
    expect(stored?.hostSessionId).toBe("sess_remote_host")
    expect(stored?.hostFingerprint).toBe("d5904a94aa8b46891cc30f9c23e9a9de")
  })

  it("a host/runtime that never resolves a fingerprint keeps the raw device target", async () => {
    hostDeviceState.value = undefined
    try {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "opencode-cli",
        cwd: CONTROLLER_CWD,
        sandbox: "device:win-host",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.descriptor.hostSessionId).toBe("sess_remote_host")
      expect(result.descriptor.hostFingerprint).toBe("win-host")
    } finally {
      hostDeviceState.value = { fingerprint: "d5904a94aa8b46891cc30f9c23e9a9de" }
    }
  })

  it("a NON-device sandbox spawn still stamps nothing (P7b's local-spawn invariant)", async () => {
    const deps = makeDeps()
    const localDeps: SpawnAgentSessionDeps = {
      ...deps,
      resolveSandboxProvider: async (slug: string) => {
        if (slug !== "local") return null
        return {
          provider: {
            async boot() {
              return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_local", async stop() {} }
            },
          },
          slug: "local",
          name: "local",
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
    const result = await spawnAgentSession(localDeps, {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "local",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.hostSessionId).toBeUndefined()
    expect(result.descriptor.hostFingerprint).toBeUndefined()
  })
})
