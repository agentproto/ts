/**
 * Regression test: sandboxPorts must be stamped on the session descriptor
 * and surfaced in the GET /sessions summary.
 *
 * Before the fix, `SpawnAgentInput` had no `sandboxPorts` field, so the value
 * passed via object spread to `registry.spawnAgent()` was silently dropped when
 * building the descriptor — `desc.sandboxPorts` was always undefined even when
 * `extraPorts: [3210]` was configured and the provider returned port URLs.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"

import { createGateway } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

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

const FAKE_AUTH: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}

describe("sandboxPorts stamping on session descriptor", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn().catch(() => undefined)
  })

  it("descriptor and summary carry sandboxPorts from the booted sandbox", async () => {
    const boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-ports-box-"))
    const hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-ports-host-"))
    const boxPort = await freePort()

    const fakeSession = (): AgentSessionLike => ({
      sessionId: "acp_ports_test",
      async *send(): AsyncIterable<AgentStreamEvent> {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    })

    const gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: boxPort,
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: async slug => {
        if (slug !== "fake-cli") return null
        return {
          commandPreview: "fake-cli (ports test)",
          authDescriptor: FAKE_AUTH,
          async startSession(): Promise<AgentSessionLike> {
            return fakeSession()
          },
        }
      },
    })
    cleanups.push(() => gateway.stop())
    cleanups.push(() => rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
    cleanups.push(() => rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))

    const PORTS: Record<number, string> = { 3210: "https://3210-x.e2b.app" }

    const providerWithPorts: SandboxProvider = {
      async boot() {
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_ports_1",
          ports: PORTS,
          async stop() {
            await gateway.stop()
          },
        }
      },
    }

    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    cleanups.push(async () => registry.shutdown())

    const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake-ports") return null
      return {
        provider: providerWithPorts,
        slug: "fake-ports",
        name: "Fake (ports)",
        version: "test",
        description: "returns pre-populated port map",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
      }
    })

    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostWorkspace,
      sandbox: "fake-ports",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Primary assertion: descriptor carries the port map.
    expect(result.descriptor.sandboxPorts).toEqual(PORTS)

    // Summary assertion: GET /sessions projection also carries sandboxPorts.
    const { summaries } = registry.listSummaries()
    const summary = summaries.find(s => s.id === result.descriptor.id)
    expect(summary?.sandboxPorts).toEqual(PORTS)
  })
})
