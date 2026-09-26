/**
 * `agent_start.sandbox` cwd resolution — gap #2 from the GTM onboarding
 * proof run (PROOF-RUN.md claim 2): a sandbox spawn with no explicit `cwd`
 * silently forwarded the HOST's own resolved cwd (active workspace /
 * worktree fallback) into the box's own `agent_start`, which reliably
 * ENOENTs there (a remote box has a disjoint filesystem) and surfaces as an
 * opaque `sandbox_proxy_failed` 500 three hops away from the actual cause.
 *
 * Covers `bootSandboxAgentSession`'s fix (session-spawn.ts): a provider that
 * declares `defaultCwd` (e2b/Box's `/home/user`, via the registry) gets that
 * default whenever the caller didn't pass `cwd` explicitly, and an explicit
 * HOST-only path (`/Volumes/…`, `/Users/…`) is rejected up front with a
 * clear `sandbox_cwd_invalid` instead of ever reaching the box.
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

// Control `~/.agentproto/workspaces.json` deterministically — the "no
// explicit cwd" tests below need the host's own cwd-resolution fallback to
// land on a real (fake) active-workspace path without touching the actual
// file on the machine running the suite.
const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

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

function makeFakeCliResolver(receivedStarts: Array<Record<string, unknown>>): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
        return {
          sessionId: "remote_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

/** Boot a real in-process daemon (the "box") and wrap it as a `SandboxProvider`.
 *  `bootSpy` lets tests assert a rejected cwd never even boots the box. */
async function bootFakeBox(receivedStarts: Array<Record<string, unknown>>): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
  bootSpy: ReturnType<typeof vi.fn>
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-cwd-test-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: makeFakeCliResolver(receivedStarts),
  })
  const bootSpy = vi.fn(async () => ({
    mcpUrl: `${gateway.url}/mcp`,
    sandboxId: "sbx_fake_1",
    async stop() {},
  }))
  const provider: SandboxProvider = { boot: bootSpy }
  return { provider, gateway, workspace, bootSpy }
}

describe("agent_start sandbox — cwd default + validation", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let box: Awaited<ReturnType<typeof bootFakeBox>>
  let registry: SessionsRegistry
  let workspace: string
  let deps: SpawnAgentSessionDeps

  /** Resolve "fake" to a provider with the given `defaultCwd` (or none, to
   *  model a same-machine passthrough provider like `local`). */
  function makeDeps(defaultCwd?: string): SpawnAgentSessionDeps {
    const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return {
        provider: box.provider,
        slug: "fake",
        name: "Fake",
        version: "test",
        description: "test double booting an in-process daemon",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        ...(defaultCwd ? { defaultCwd } : {}),
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

  beforeEach(async () => {
    receivedStarts = []
    box = await bootFakeBox(receivedStarts)
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-cwd-host-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    deps = makeDeps("/home/user")
    wsConfigState.value = { version: 1, workspaces: [] }
  })

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("no explicit cwd: the host's active-workspace fallback (a host-only path) is replaced by the provider's defaultCwd", async () => {
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
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.cwd).toBe("/home/user")
    // The ledger/descriptor cwd agree with what was actually sent to the box.
    expect(result.descriptor.cwd).toBe("/home/user")
  })

  it("explicit cwd that already looks like a box path is forwarded as-is", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: "/home/user/project",
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.cwd).toBe("/home/user/project")
  })

  it("explicit HOST-only cwd (macOS /Volumes/…) is rejected with sandbox_cwd_invalid — never reaches the box", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts",
      sandbox: "fake",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_cwd_invalid")
    expect(result.message).toContain("/home/user")
    expect(box.bootSpy).not.toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(0)
  })

  it("explicit HOST-only cwd (macOS /Users/…) is rejected the same way", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: "/Users/op/projects/some-repo",
      sandbox: "fake",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_cwd_invalid")
  })

  it("a provider with NO defaultCwd (e.g. local) forwards a host-shaped explicit cwd unchanged — no rejection", async () => {
    deps = makeDeps(undefined)
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: "/Users/op/projects/some-repo",
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.cwd).toBe("/Users/op/projects/some-repo")
  })

  it("a provider with NO defaultCwd leaves the host's active-workspace fallback untouched", async () => {
    deps = makeDeps(undefined)
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
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedStarts[0]?.cwd).toBe("/Users/op/projects/some-repo")
  })
})
