/**
 * Sandbox liveness — the box-death signal, distinct from session death.
 *
 * Real sequence (observed live on e2b): a box vanishes ("Sandbox Not
 * Found") while the ledger still says paused and still advertises the app
 * URL. Exercises the REAL HTTP layer via `startHttpServer` (same pattern as
 * routines-http-routes.test.ts) with a fake `SandboxProviderHandle`, plus
 * the reconnect path (`spawnAgentSession` with `sandbox.reuse`) flipping
 * the ledger row to "gone" when the provider answers not-found.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { SandboxBoxGoneError, type SandboxProvider } from "@agentproto/sandbox"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import { recordSandboxBoot, recordSandboxState, readSandboxLedger } from "../sandbox-ledger.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { AgentAdapterResolver } from "../http-server.js"


function fakeHandle(provider: SandboxProvider): SandboxProviderHandle {
  return {
    provider,
    slug: "fake",
    name: "Fake",
    version: "test",
    description: "test double",
    requiresSetup: false,
    capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
    async check() {
      return true
    },
  }
}

describe("sandbox liveness — GET /sandboxes/:id/alive + gone-on-reconnect", () => {
  let workspace: string
  let ledgerPath: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-live-"))
    ledgerPath = join(workspace, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
  })
  afterEach(async () => {
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    await rm(workspace, { recursive: true, force: true })
  })

  function seedPaused(sandboxId: string): void {
    recordSandboxBoot({ sandboxId, provider: "fake", state: "booted" })
    recordSandboxState(sandboxId, "paused")
  }

  async function withServer(
    provider: SandboxProvider | undefined,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      resolveSandboxProvider: async slug =>
        slug === "fake" && provider ? fakeHandle(provider) : null,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("ledger says paused, provider probe says NOT FOUND → route answers 410 and flips the ledger row to gone", async () => {
    seedPaused("sbx_dead")
    const provider: SandboxProvider = {
      async boot() {
        throw new Error("never boots in this test")
      },
      async probe() {
        return { alive: false }
      },
    }
    await withServer(provider, async base => {
      const res = await fetch(`${base}/sandboxes/sbx_dead/alive`)
      expect(res.status).toBe(410)
      const body = (await res.json()) as { alive: boolean; state: string; checkedAt: string }
      expect(body.alive).toBe(false)
      expect(body.state).toBe("gone")
      expect(typeof body.checkedAt).toBe("string")
    })
    const [row] = readSandboxLedger()
    expect(row?.state).toBe("gone")
    expect(row?.sandboxAlive).toBe(false)
    expect(typeof row?.sandboxCheckedAt).toBe("string")
  })

  it("probe says alive → 200 with the provider state; ledger records the verdict without changing its own state", async () => {
    seedPaused("sbx_live")
    const provider: SandboxProvider = {
      async boot() {
        throw new Error("never boots in this test")
      },
      async probe() {
        return { alive: true, state: "running" }
      },
    }
    await withServer(provider, async base => {
      const res = await fetch(`${base}/sandboxes/sbx_live/alive`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { alive: boolean; state: string; checkedAt: string }
      expect(body.alive).toBe(true)
      expect(body.state).toBe("running")
    })
    const [row] = readSandboxLedger()
    expect(row?.state).toBe("paused")
    expect(row?.sandboxAlive).toBe(true)
    expect(typeof row?.sandboxCheckedAt).toBe("string")
  })

  it("unknown sandbox id → 404; provider with no probe() → 501; probe error → 502 (unknown, never death)", async () => {
    seedPaused("sbx_ok")
    const provider: SandboxProvider = {
      async boot() {
        throw new Error("never boots in this test")
      },
      async probe() {
        throw new Error("e2b API 503")
      },
    }
    await withServer(provider, async base => {
      expect((await fetch(`${base}/sandboxes/sbx_unknown/alive`)).status).toBe(404)

      const failing = await fetch(`${base}/sandboxes/sbx_ok/alive`)
      expect(failing.status).toBe(502)
      const body = (await failing.json()) as { alive: unknown }
      expect(body.alive).toBeNull()

      const [row] = readSandboxLedger()
      expect(row?.state).toBe("paused")
    })
    await withServer(
      {
        async boot() {
          throw new Error("never boots in this test")
        },
      },
      async base => {
        const res = await fetch(`${base}/sandboxes/sbx_ok/alive`)
        expect(res.status).toBe(501)
      },
    )
  })

  it("reconnect path: a provider not-found (SandboxBoxGoneError) fails the spawn AND marks the ledger row gone", async () => {
    seedPaused("sbx_gone")
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    const provider: SandboxProvider = {
      async boot() {
        throw new Error("never boots in this test")
      },
      async connect() {
        throw new SandboxBoxGoneError("sbx_gone")
      },
    }
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: (async () => null) as AgentAdapterResolver,
      resolveSandboxProvider: async slug => (slug === "fake" ? fakeHandle(provider) : null),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
    try {
      const result = await spawnAgentSession(deps, {
        adapter: "fake-cli",
        cwd: workspace,
        sandbox: { provider: "fake", config: {}, reuse: "sbx_gone" },
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("sandbox_reconnect_failed")
      const [row] = readSandboxLedger()
      expect(row?.state).toBe("gone")
      expect(row?.sandboxAlive).toBe(false)
      expect(typeof row?.sandboxCheckedAt).toBe("string")
    } finally {
      registry.shutdown()
    }
  })

  it("reconnect failure that is NOT box-gone leaves the ledger row untouched (still paused)", async () => {
    seedPaused("sbx_flaky")
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    const provider: SandboxProvider = {
      async boot() {
        throw new Error("never boots in this test")
      },
      async connect() {
        throw new Error("network reset")
      },
    }
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: (async () => null) as AgentAdapterResolver,
      resolveSandboxProvider: async slug => (slug === "fake" ? fakeHandle(provider) : null),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
    try {
      const result = await spawnAgentSession(deps, {
        adapter: "fake-cli",
        cwd: workspace,
        sandbox: { provider: "fake", config: {}, reuse: "sbx_flaky" },
      })
      expect(result.ok).toBe(false)
      const [row] = readSandboxLedger()
      expect(row?.state).toBe("paused")
      expect(row?.sandboxAlive).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})

// ── tiny stubs (mirror routines-http-routes.test.ts) ──

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}