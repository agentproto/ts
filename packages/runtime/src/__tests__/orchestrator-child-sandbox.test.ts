/**
 * Orchestrator sub-gateway — a CHILD spawned THROUGH the scoped gateway can
 * resolve a sandbox provider.
 *
 * Regression guard for the gap: `createGateway` threads
 * `resolveSandboxProvider` into the root `/mcp` `agent_start`, but the scoped
 * orchestrator sub-gateway (`createOrchestratorMcpServerFactory`) did NOT
 * forward it — so a parent-spawned child declared with `sandbox: "..."` hit
 * the "no sandbox provider resolver wired (createGateway needs
 * `resolveSandboxProvider`)" throw even though the daemon HAS a resolver.
 *
 * Proves the wiring both ways:
 *   - factory WITH `resolveSandboxProvider` → the resolver IS invoked and the
 *     child boots a (fake) box, returning a remote descriptor;
 *   - factory WITHOUT it → the spawn fails with the exact "resolver not
 *     wired" message (the pre-fix behaviour), and no resolver is consulted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { SandboxProvider } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  createOrchestratorMcpServerFactory,
  createScopeTokenRegistry,
} from "../orchestrator-gateway.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
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

/** Fake CLI adapter for the BOX's own `agent_start` — a normal, empty turn. */
const fakeCliResolver: AgentAdapterResolver = async slug => {
  if (slug !== "fake-cli") return null
  return {
    commandPreview: "fake-cli (test double)",
    async startSession(): Promise<AgentSessionLike> {
      return {
        sessionId: "remote_sess_1",
        // eslint-disable-next-line require-yield
        async *send(): AsyncIterable<AgentStreamEvent> {
          return
        },
        async cancel() {},
        async close() {},
      }
    },
  }
}

/** Boot a real in-process daemon (the "box") and wrap it as a SandboxProvider. */
async function bootFakeBox(): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-orch-sbx-box-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: fakeCliResolver,
  })
  const provider: SandboxProvider = {
    async boot() {
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId: "sbx_fake_1",
        async stop() {
          await gateway.stop()
        },
      }
    },
  }
  return { provider, gateway, workspace }
}

describe("orchestrator sub-gateway — child sandbox resolution", () => {
  let box: Awaited<ReturnType<typeof bootFakeBox>>
  let registry: SessionsRegistry
  let hostWorkspace: string
  let resolveSandboxProviderSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    box = await bootFakeBox()
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-orch-sbx-host-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    resolveSandboxProviderSpy = vi.fn(
      async (slug: string): Promise<SandboxProviderHandle | null> => {
        if (slug !== "fake") return null
        return {
          provider: box.provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "test double booting an in-process daemon",
          requiresSetup: false,
          capabilities: {
            networkEgress: false,
            mounts: false,
            lifecyclePause: false,
            readOnly: false,
          },
          async check() {
            return true
          },
        }
      },
    )
  })

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  /** Build a scoped-gateway MCP client, optionally wiring the sandbox resolver. */
  async function scopedClient(wireSandbox: boolean): Promise<Client> {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const factory = createOrchestratorMcpServerFactory({
      workspace: hostWorkspace,
      registry,
      sessionEvents,
      eventRing,
      resolveAgentAdapter: fakeCliResolver,
      ...(wireSandbox ? { resolveSandboxProvider: resolveSandboxProviderSpy } : {}),
    })
    const scope = createScopeTokenRegistry().mint()
    const server = await factory(scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "orch-sbx-test", version: "0.0.1" })
    await client.connect(clientTransport)
    return client
  }

  it("resolves a sandbox provider for a scoped-gateway child — resolver invoked, box booted, no throw", async () => {
    const client = await scopedClient(true)
    const result = await client.callTool({
      name: "agent_start",
      arguments: { adapter: "fake-cli", cwd: hostWorkspace, sandbox: "fake" },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    const desc = JSON.parse(text) as {
      remote?: boolean
      sandboxId?: string
      error?: string
    }

    // The scoped gateway forwarded the resolver — it was actually consulted.
    expect(resolveSandboxProviderSpy).toHaveBeenCalledWith("fake")
    // And the child booted the (fake) box: a remote descriptor came back, NOT
    // the "resolver not wired" error.
    expect(result.isError).toBeFalsy()
    expect(desc.remote).toBe(true)
    expect(desc.sandboxId).toBe("sbx_fake_1")

    await client.close()
  })

  it("without the resolver wired, a scoped-gateway child's sandbox spawn fails with the 'not wired' error (pre-fix behaviour)", async () => {
    const client = await scopedClient(false)
    const result = await client.callTool({
      name: "agent_start",
      arguments: { adapter: "fake-cli", cwd: hostWorkspace, sandbox: "fake" },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""

    expect(result.isError).toBe(true)
    expect(text).toContain("no sandbox provider resolver wired")
    // The resolver instance is never consulted when it isn't forwarded.
    expect(resolveSandboxProviderSpy).not.toHaveBeenCalled()

    await client.close()
  })
})
