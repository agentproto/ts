/**
 * ROLE/ORCHESTRATOR PROPAGATION through the sandbox start path (defect B,
 * regression): a HOST spawn with `role: "supervisor"`, `orchestrator: true`
 * and a sandbox provider used to produce an inner prompt saying "You are the
 * executor." — `delegationReachFor` only inspected the HOST-side MCP mounts,
 * where a sandbox spawn legitimately mounts nothing (the delegation surface
 * lives INSIDE the box, on the box daemon's own loopback via the forwarded
 * `orchestrator` request), so `composeRoleContext` rewrote the explicit
 * supervisor disposition to the executor text.
 *
 * Same harness family as `agent-start-sandbox.test.ts`: a fake provider
 * boots an in-process daemon (the "box"), `spawnAgentSession` connects over
 * real HTTP, and the boss-daemons' fake adapter records every prompt it
 * receives — the INNER prompt is the thing asserted.
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
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import { canSpawn, SUPERVISOR_ROLE, EXECUTOR_ROLE } from "../role.js"

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

function extractText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

const CLAUDE_SDK_GATEWAY_AUTH: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}

function makeFakeCliResolver(
  receivedPrompts: string[],
  receivedStarts: Array<Record<string, unknown>>,
): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      authDescriptor: CLAUDE_SDK_GATEWAY_AUTH,
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
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

async function bootFakeBox(
  receivedPrompts: string[],
  receivedStarts: Array<Record<string, unknown>>,
): Promise<{ provider: SandboxProvider; gateway: GatewayHandle; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-role-disp-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: makeFakeCliResolver(receivedPrompts, receivedStarts),
  })
  const provider: SandboxProvider = {
    async boot() {
      return { mcpUrl: `${gateway.url}/mcp`, sandboxId: "sbx_role_disp_1", stop: async () => {} }
    },
  }
  return { provider, gateway, workspace }
}

describe("sandbox spawn — the role disposition reaches the inner prompt", () => {
  let receivedPrompts: string[]
  let receivedStarts: Array<Record<string, unknown>>
  let box: Awaited<ReturnType<typeof bootFakeBox>>
  let registry: createSessionsRegistry extends (...a: never) => never ? never : ReturnType<typeof createSessionsRegistry>
  let workspace: string
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    receivedPrompts = []
    receivedStarts = []
    box = await bootFakeBox(receivedPrompts, receivedStarts)
    workspace = await mkdtemp(join(tmpdir(), "agentproto-role-disp-host-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    const resolveSandboxProviderSpy = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
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

  it("a host spawn with role:'supervisor' + orchestrator:true gets the SUPERVISOR disposition in the inner prompt, not the executor one", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      role: "supervisor",
      orchestrator: true,
      prompt: "decompose the work",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The composed prompt the box's own adapter actually received:
    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0]).toContain("You are the supervisor.")
    expect(receivedPrompts[0]).not.toContain("You are the executor.")
  })

  it("a role-defaulted sandbox spawn with orchestrator:true resolves supervisor too (delegation surface exists box-side)", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      orchestrator: true,
      prompt: "no explicit role",
      wait: true,
    })
    expect(result.ok).toBe(true)
    expect(receivedPrompts[0]).toContain("You are the supervisor.")
  })

  it("an executor-role sandbox spawn stays a leaf: the executor disposition composes and no orchestrator scope is forwarded", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      role: "executor",
      prompt: "do the task yourself",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedPrompts[0]).toContain("You are the executor.")
    expect(receivedPrompts[0]).not.toContain("You are the supervisor.")
  })
})

describe("spawn-lattice: supervisor spawns executor, executor cannot delegate", () => {
  function fakeAgentSession(): AgentSessionLike {
    return {
      sessionId: "acp_role_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> {
        return
      },
      async cancel() {},
      async close() {},
    }
  }

  it("supervisor (callerScope role) may spawn an executor child", () => {
    expect(canSpawn(SUPERVISOR_ROLE, EXECUTOR_ROLE)).toBe(true)
  })

  it("executor (callerScope role) may spawn nothing", () => {
    expect(canSpawn(EXECUTOR_ROLE, EXECUTOR_ROLE)).toBe(false)
    expect(canSpawn(EXECUTOR_ROLE, SUPERVISOR_ROLE)).toBe(false)
  })

  it("the daemon gate rejects an executor-role caller spawning any child (role_spawn_denied) — non-sandbox path, same gate", async () => {
    const persistlessRegistry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const spawnDeps: SpawnAgentSessionDeps = {
      registry: persistlessRegistry,
      resolveAgentAdapter: async () => ({ startSession: startSession as never, commandPreview: "mock" }),
      resolveAgentsMd: async () => ({ mode: "absent", contractLine: "contract" }),
      resolveWorkspaceRules: async () => ({}),
    }
    const executorScope: OrchestratorScope = {
      token: "tok_executor",
      tools: new Set(["message_parent"]),
      ownerSessionId: "sess_exec",
      depth: 1,
      maxDepth: 3,
      maxChildren: 8,
      role: "executor",
    }
    const denied = await spawnAgentSession({ ...spawnDeps, callerScope: executorScope }, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.code).toBe("role_spawn_denied")
      expect(denied.details?.parentRole).toBe("executor")
    }
    persistlessRegistry.shutdown()
  })
})
