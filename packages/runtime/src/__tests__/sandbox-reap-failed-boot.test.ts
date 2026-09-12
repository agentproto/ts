/**
 * Failed-boot sandbox reaping — a spawn that fails AFTER the provider
 * created/returned a box must pause-or-kill that box exactly once and
 * stamp the sandbox ledger with the outcome. Covers:
 *   - fresh boot whose daemon MCP connect fails → box killed, ledger "stopped"
 *   - reconnect (reuse) whose daemon MCP connect fails → box paused (when
 *     the provider supports it), ledger "paused"
 *   - the box's own `agent_start` failing → box killed, ledger "stopped"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type AddressInfo } from "node:net"
import type { BootedSandbox, SandboxProvider } from "@agentproto/sandbox"

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import { readSandboxLedger } from "../sandbox-ledger.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

const DEAD_MCP_URL = "http://127.0.0.1:9/mcp" // discard port — ECONNREFUSED

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

/** A provider whose boxes exist but whose daemon endpoint is unreachable —
 *  the exact "box created, MCP connect failed" accumulation shape. */
function makeDeadBoxProvider(opts: { pause?: boolean } = {}): {
  provider: SandboxProvider
  stops: string[]
  pauses: string[]
} {
  const stops: string[] = []
  const pauses: string[] = []
  const boot = (sandboxId: string): BootedSandbox => ({
    mcpUrl: DEAD_MCP_URL,
    sandboxId,
    stop: async () => {
      stops.push(sandboxId)
    },
    ...(opts.pause
      ? {
          pause: async () => {
            pauses.push(sandboxId)
          },
        }
      : {}),
  })
  const provider: SandboxProvider = {
    async boot() {
      return boot("sbx_dead_fresh")
    },
    async connect(sandboxId) {
      return boot(sandboxId)
    },
  }
  return { provider, stops, pauses }
}

function makeHandle(provider: SandboxProvider): SandboxProviderHandle {
  return {
    provider,
    slug: "fake",
    name: "Fake",
    version: "test",
    description: "test double with an unreachable box daemon",
    requiresSetup: false,
    capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
    async check() {
      return true
    },
  }
}

describe("failed-boot sandbox reaping", () => {
  let workspace: string
  let ledgerPath: string
  let registry: ReturnType<typeof createSessionsRegistry>
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-reap-test-"))
    ledgerPath = join(workspace, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    deps = {
      registry,
      resolveAgentAdapter: async () => null,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    registry.shutdown()
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("a fresh boot that fails after the box was created kills the box exactly once and marks the ledger stopped", async () => {
    const fake = makeDeadBoxProvider()
    const result = await spawnAgentSession(
      { ...deps, resolveSandboxProvider: async slug => (slug === "fake" ? makeHandle(fake.provider) : null) },
      { adapter: "anything", cwd: workspace, sandbox: "fake" },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_boot_failed")
    expect(fake.stops).toEqual(["sbx_dead_fresh"])
    expect(fake.pauses).toEqual([])

    const entries = readSandboxLedger(ledgerPath)
    const entry = entries.find(e => e.sandboxId === "sbx_dead_fresh")
    expect(entry?.state).toBe("stopped")
    expect(entry?.provider).toBe("fake")
  })

  it("a reconnect failure pauses the (already-existing) box once when the provider supports pause and marks the ledger paused", async () => {
    const fake = makeDeadBoxProvider({ pause: true })
    const result = await spawnAgentSession(
      { ...deps, resolveSandboxProvider: async slug => (slug === "fake" ? makeHandle(fake.provider) : null) },
      {
        adapter: "anything",
        cwd: workspace,
        sandbox: { provider: "fake", config: {}, reuse: "sbx_prior_box" },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_reconnect_failed")
    expect(fake.pauses).toEqual(["sbx_prior_box"])
    expect(fake.stops).toEqual([])

    const entry = readSandboxLedger(ledgerPath).find(e => e.sandboxId === "sbx_prior_box")
    expect(entry?.state).toBe("paused")
  })

  it("the box's own agent_start failing kills the box and marks the ledger stopped", { timeout: 30_000 }, async () => {
    // A healthy fake box daemon whose agent_start rejects the adapter.
    const stops: string[] = []
    const { createGateway } = await import("../index.js")
    const port = await freePort()
    const boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-reap-box-"))
    const gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port,
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: async () => null, // every agent_start fails
    })
    const provider: SandboxProvider = {
      async boot() {
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_proxy_fail",
          stop: async () => {
            stops.push("sbx_proxy_fail")
          },
        }
      },
    }
    try {
      const result = await spawnAgentSession(
        { ...deps, resolveSandboxProvider: async slug => (slug === "fake" ? makeHandle(provider) : null) },
        { adapter: "no-such-adapter", cwd: workspace, sandbox: "fake" },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("sandbox_proxy_failed")
      expect(stops).toEqual(["sbx_proxy_fail"])
      const entry = readSandboxLedger(ledgerPath).find(e => e.sandboxId === "sbx_proxy_fail")
      expect(entry?.state).toBe("stopped")
    } finally {
      await gateway.stop()
      await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })

  it("the ledger file on disk carries the stamped state (JSON parseable)", async () => {
    const fake = makeDeadBoxProvider()
    await spawnAgentSession(
      { ...deps, resolveSandboxProvider: async slug => (slug === "fake" ? makeHandle(fake.provider) : null) },
      { adapter: "anything", cwd: workspace, sandbox: "fake" },
    )
    const raw = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      sandboxes: Array<{ sandboxId: string; state: string }>
    }
    expect(raw.sandboxes.some(e => e.sandboxId === "sbx_dead_fresh" && e.state === "stopped")).toBe(
      true,
    )
  })
})