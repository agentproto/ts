/**
 * `SandboxProviderHandle.omitCwdWhenImplicit` (DEVICES-PLAN PR-D) —
 * `bootSandboxAgentSession`'s cwd handling for the `device` sandbox
 * provider: unlike e2b/Box (whose `defaultCwd` substitutes a KNOWN in-box
 * path), a paired device's "box" is another user's own machine, so there is
 * no known default to substitute — the fix is to omit `cwd` from the box's
 * own `agent_start` call entirely whenever the caller passed no explicit
 * `agent_start.cwd`, letting the remote apply its own default-cwd
 * resolution instead of ENOENTing on a forwarded HOST-shaped path.
 *
 * Mocks `@agentproto/sandbox`'s `createSandboxAgentSessionHost` directly
 * (rather than booting a real second daemon, as `agent-start-sandbox-cwd
 * .test.ts` does for `defaultCwd`) so the assertions can inspect the EXACT
 * args object `bootSandboxAgentSession` builds for `host.start()` — cwd
 * default-resolution on a real remote daemon would independently resolve to
 * a value that can coincidentally match the host's own fallback, which
 * can't distinguish "omitted" from "forwarded-and-happened-to-match".
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
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

function makeDeps(registry: SessionsRegistry, omitCwdWhenImplicit: boolean): SpawnAgentSessionDeps {
  const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
    if (slug !== "device:work-mac") return null
    return {
      provider: {
        async boot() {
          return {
            mcpUrl: "http://127.0.0.1:0/mcp",
            sandboxId: "sbx_fake_device",
            async stop() {},
          }
        },
      },
      slug: "device:work-mac",
      name: "work-mac",
      version: "builtin",
      description: "test double",
      requiresSetup: false,
      capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
      omitCwdWhenImplicit,
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

describe("bootSandboxAgentSession — omitCwdWhenImplicit (device sandbox)", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-cwd-test-"))
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

  it("omitCwdWhenImplicit + no explicit cwd: host.start() is called with NO cwd field at all", async () => {
    const result = await spawnAgentSession(makeDeps(registry, true), {
      adapter: "whatever-cli",
      sandbox: "device:work-mac",
    })
    expect(result.ok).toBe(true)
    expect(startMock).toHaveBeenCalledTimes(1)
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect("cwd" in args).toBe(false)
  })

  it("omitCwdWhenImplicit + no explicit cwd: descriptor.cwd falls back to the remote's own reported cwd", async () => {
    startMock.mockResolvedValue({ id: "remote_sess_1", cwd: "/home/device-user/workspace" })
    const result = await spawnAgentSession(makeDeps(registry, true), {
      adapter: "whatever-cli",
      sandbox: "device:work-mac",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.cwd).toBe("/home/device-user/workspace")
  })

  it("omitCwdWhenImplicit + no explicit cwd + remote reports no cwd: descriptor.cwd falls back to the host's own resolved cwd", async () => {
    const result = await spawnAgentSession(makeDeps(registry, true), {
      adapter: "whatever-cli",
      sandbox: "device:work-mac",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.cwd).toBe("/Users/op/projects/some-repo")
  })

  it("omitCwdWhenImplicit + EXPLICIT cwd: cwd IS forwarded as-is (the flag only affects the implicit case)", async () => {
    const result = await spawnAgentSession(makeDeps(registry, true), {
      adapter: "whatever-cli",
      cwd: "/explicit/box/path",
      sandbox: "device:work-mac",
    })
    expect(result.ok).toBe(true)
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.cwd).toBe("/explicit/box/path")
  })

  it("omitCwdWhenImplicit unset (default false) + no explicit cwd: cwd IS forwarded — today's behavior for every other provider is unchanged", async () => {
    const result = await spawnAgentSession(makeDeps(registry, false), {
      adapter: "whatever-cli",
      sandbox: "device:work-mac",
    })
    expect(result.ok).toBe(true)
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.cwd).toBe("/Users/op/projects/some-repo")
  })
})
