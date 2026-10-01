/**
 * Device-spawn transport retry (device-spawn UX fix 1).
 *
 * Field finding: when a `device:<fp>` spawn's E2E host channel is flapping,
 * the inner `agent_start` over the channel (`host.start()`) failed with a
 * transport-class error and the whole call surfaced as a bare MCP
 * `Request timed out` — no retry, no actionable error. The fix wraps the
 * device spawn attempt in ONE automatic retry with a short back-off and, on
 * a spent budget, returns a `device_spawn_unreachable` result naming the
 * target, the attempts, and the retry guidance.
 *
 * `@agentproto/sandbox`'s `createSandboxAgentSessionHost` is mocked (same
 * seam `session-spawn-device-agentsmd.test.ts` uses) so the remote-facing
 * `host.start()` is a controlled double, and the sandbox ledger is
 * in-memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  vi.fn(async (_args: Record<string, unknown>) => ({ id: "remote_sess_1", cwd: "/remote" })),
)
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

import {
  spawnAgentSession,
  isDeviceTransportError,
  type SpawnAgentSessionDeps,
} from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

describe("isDeviceTransportError", () => {
  it("matches the transport-class shapes and nothing else", () => {
    expect(isDeviceTransportError(new Error("device_unreachable"))).toBe(true)
    expect(isDeviceTransportError(new Error("transport closed during handshake"))).toBe(true)
    expect(isDeviceTransportError(new Error("handshake timed out"))).toBe(true)
    expect(isDeviceTransportError(new Error("read ECONNRESET"))).toBe(true)
    expect(isDeviceTransportError(new Error("host ... did not send hello"))).toBe(true)
    expect(isDeviceTransportError(new Error("Tool `agent_start` returned error: adapter_not_found"))).toBe(
      false,
    )
  })
})

describe("spawnAgentSession — device spawn transport retry", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-retry-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockReset()
  })

  afterEach(async () => {
    registry.shutdown()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function makeDeps(): SpawnAgentSessionDeps {
    const makeHandle = (slug: string) => ({
      provider: {
        async boot() {
          return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_fake", async stop() {} }
        },
      },
      slug,
      name: slug,
      version: "builtin",
      description: "test double",
      requiresSetup: false,
      capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
      omitCwdWhenImplicit: true,
      async check() {
        return true
      },
    })
    return {
      registry,
      resolveAgentAdapter: async () => null,
      resolveSandboxProvider: async (slug: string) =>
        slug === "device:win-host" || slug === "fake" ? (makeHandle(slug) as never) : null,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  }

  it("retries ONCE on a transport-class error and succeeds on the second attempt", async () => {
    startMock
      .mockRejectedValueOnce(new Error("device_unreachable"))
      .mockResolvedValueOnce({ id: "remote_sess_1", cwd: "/remote" })

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
    })

    expect(result.ok).toBe(true)
    expect(startMock).toHaveBeenCalledTimes(2)
  })

  it("fails with device_spawn_unreachable (naming target + attempts + guidance) after the retry budget", async () => {
    startMock.mockRejectedValue(new Error("device_unreachable"))

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("device_spawn_unreachable")
    expect(result.message).toContain("win-host")
    expect(result.message).toContain("2 attempts")
    expect(result.message).toContain("agentproto devices status win-host")
    expect(result.message).toContain("device_unreachable")
    expect(startMock).toHaveBeenCalledTimes(2)
    // No orphaned local session row.
    expect(registry.list()).toHaveLength(0)
  })

  it("does NOT retry a non-transport failure (the host's own agent_start rejection)", async () => {
    startMock.mockRejectedValue(new Error("Tool `agent_start` returned error: adapter_not_found"))

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_proxy_failed")
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("does NOT retry a non-device sandbox transport error (local/e2b/Box unchanged)", async () => {
    startMock.mockRejectedValue(new Error("device_unreachable"))

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_proxy_failed")
    expect(startMock).toHaveBeenCalledTimes(1)
  })
})
