/**
 * `session_restart` on a sandboxed agent session — the box re-attach path.
 *
 * Regression: `restartAgentSession` used to have no remote/sandbox branch, so
 * restarting a session that ran inside a sandbox resolved the adapter
 * LOCALLY and spawned it with `cwd = prev.cwd` — a path INSIDE the box
 * (`/home/user`) — on the host (`spawn ... ENOENT, cwd '/home/user' does not
 * exist`). The fixed path resolves the box's provider, `connect()`s the
 * EXISTING `sandboxId` (never boots a fresh box), and re-spawns the adapter
 * on the box's own `agent_start` — exercised here over the real wire: a fake
 * `SandboxProvider.connect` wraps an in-process daemon (`createGateway`), the
 * same harness `agent-start-sandbox.test.ts` uses for the boot path.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

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

function makeFakeCliResolver(): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (host test double)",
      async startSession(): Promise<AgentSessionLike> {
        throw new Error("LOCAL SPAWN MUST NOT HAPPEN for a sandbox session restart")
      },
    }
  }
}

/** Boot a real in-process daemon (the "box") whose provider supports
 *  `connect()` — the re-attach path a sandbox restart must take. */
async function bootReconnectableBox(
  receivedStarts: Array<Record<string, unknown>>,
): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
  connectCalls: string[]
  connectSpecs: SandboxSpec[]
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-box-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: async slug => {
      if (slug !== "fake-cli") return null
      return {
        commandPreview: "fake-cli (box test double)",
        async startSession(args): Promise<AgentSessionLike> {
          receivedStarts.push(args as Record<string, unknown>)
          return fakeAgentSession("box")
        },
      }
    },
  })
  const connectCalls: string[] = []
  const connectSpecs: SandboxSpec[] = []
  const provider: SandboxProvider = {
    async boot(): Promise<never> {
      throw new Error("boot must never be called — a restart reconnects via connect()")
    },
    async connect(sandboxId: string, spec: SandboxSpec) {
      connectCalls.push(sandboxId)
      connectSpecs.push(spec)
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId,
        async stop() {
          await gateway.stop()
        },
      }
    },
  }
  return { provider, gateway, workspace, connectCalls, connectSpecs }
}function makeResolver(
  box: Awaited<ReturnType<typeof bootReconnectableBox>>,
): { resolver: AgentAdapterResolver; providerResolver: (slug: string) => Promise<SandboxProviderHandle | null> } {
  const resolver: AgentAdapterResolver = makeFakeCliResolver()
  const providerResolver = async (slug: string): Promise<SandboxProviderHandle | null> => {
    if (slug !== "fake") return null
    return {
      provider: box.provider,
      slug: "fake",
      name: "Fake",
      version: "test",
      description: "test double exposing a connect() to an in-process daemon",
      requiresSetup: false,
      capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
      async check() {
        return true
      },
    }
  }
  return { resolver, providerResolver }
}

describe("restartAgentSession on a sandboxed session", () => {
  const receivedStarts: Array<Record<string, unknown>> = []
  let box: Awaited<ReturnType<typeof bootReconnectableBox>>
  let registry: SessionsRegistry
  let hostWorkspace: string
  let prev: ReturnType<SessionsRegistry["spawnAgent"]>

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function setup(): Promise<{
    resolver: AgentAdapterResolver
    providerResolver: (slug: string) => Promise<SandboxProviderHandle | null>
  }> {
    receivedStarts.length = 0
    box = await bootReconnectableBox(receivedStarts)
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-host-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: fakeAgentSession("box"),
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_prev_1",
      sandboxTeardown: "pause",
    })
    registry.kill(prev.id)
    return makeResolver(box)
  }

  it("re-attaches the EXISTING box via connect() and re-spawns the adapter inside it — never a local spawn", async () => {
    const { resolver, providerResolver } = await setup()

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    expect(box.connectCalls).toEqual(["sbx_prev_1"])
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.cwd).toBe("/home/user")

    expect(result.resumedFrom).toBe(prev.id)
    expect(result.resumeFallback).toBe(true)
    expect(result.desc.remote).toBe(true)
    expect(result.desc.sandboxId).toBe("sbx_prev_1")
    expect(result.desc.sandboxTeardown).toBe("pause")
    expect(result.desc.command).toBe("sandbox:fake → fake-cli")
    expect(result.desc.command).toBe("sandbox:fake → fake-cli")
    expect(result.desc.resumeVia).toBe("")
    expect(result.desc.cwd).toBe("/home/user")
    expect(result.desc.adapterSlug).toBe("fake-cli")
  })

  it("forwards the overrides (model/effort) to the box's agent_start and stamps them on the fresh descriptor", async () => {
    const { resolver, providerResolver } = await setup()

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
      overrides: { model: "kimi/k2", effort: "high" },
    })

    expect(receivedStarts[0]?.model).toBe("kimi/k2")
    expect(receivedStarts[0]?.effort).toBe("high")
    expect(result.desc.model).toBe("kimi/k2")
    expect(result.desc.effort).toBe("high")
  })

  it("fails LOUD when the box is expired — never falls back to a local spawn", async () => {
    const { resolver, providerResolver } = await setup()
    // Reconnect failure = the box is gone.
    const failing: (slug: string) => Promise<SandboxProviderHandle | null> = async slug => {
      const handle = await providerResolver(slug)
      if (!handle) return null
      return {
        ...handle,
        provider: {
          async boot(): Promise<never> {
            throw new Error("boot must never be called — a restart reconnects via connect()")
          },
          async connect(): Promise<never> {
            throw new Error("sandbox not found")
          },
        },
      }
    }

    await expect(
      restartAgentSession(registry, resolver, prev, { resolveSandboxProvider: failing }),
    ).rejects.toThrow(/sbx_prev_1.*expired.*spawn a fresh session/i)
    // The decisive regression assertion: no local adapter spawn happened.
    expect(receivedStarts).toHaveLength(0)
  })

  it("fails LOUD when no sandbox provider resolver is wired (instead of spawning locally)", async () => {
    const { resolver } = await setup()

    await expect(restartAgentSession(registry, resolver, prev)).rejects.toThrow(
      /no sandbox provider resolver/,
    )
    expect(receivedStarts).toHaveLength(0)
  })
})
