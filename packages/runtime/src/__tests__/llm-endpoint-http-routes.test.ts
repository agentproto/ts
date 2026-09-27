/**
 * `GET /llm-endpoint/status` + `POST /llm-endpoint/restart` REST routes —
 * exercises the real REST layer via `startHttpServer`, same pattern as
 * routines-http-routes.test.ts. Uses the same mocked-seam `LlmEndpointRegistry`
 * subclass llm-endpoint-registry.test.ts uses (`launch`/`probeHealth`
 * overridden) so no real process is spawned.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import {
  LlmEndpointRegistry,
  type EndpointProcess,
  type LaunchOptions,
} from "../llm-endpoint-registry.js"

/** Same seam style as llm-endpoint-registry.test.ts's `MockRegistry`: `launch`
 *  and `probeHealth` overridden so the state machine runs without a real
 *  spawned process. `start` still validates the resolved bin path (via
 *  `existsSync`), so `binPath` must point at something real — this module's
 *  own file always exists. */
const EXISTING_BIN = fileURLToPath(import.meta.url)

class MockRegistry extends LlmEndpointRegistry {
  launchCalls: number[] = [] // records the port each launch() call used
  healthy = true

  protected override async launch(opts: LaunchOptions): Promise<EndpointProcess> {
    this.launchCalls.push(opts.port)
    return {
      pid: 9000 + this.launchCalls.length,
      async stop() {},
    }
  }

  protected override async probeHealth(): Promise<boolean> {
    return this.healthy
  }
}

function makeRegistry(): MockRegistry {
  return new MockRegistry({
    injectKeys: async () => [],
    injectLinks: async () => [],
    binPath: EXISTING_BIN,
    readyTimeoutMs: 200,
    pollIntervalMs: 5,
  })
}

describe("/llm-endpoint REST routes", () => {
  async function withServer(
    registry: LlmEndpointRegistry | undefined,
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
      ...(registry ? { llmEndpoint: registry } : {}),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("404s when no registry is wired (features.llmEndpoint off)", async () => {
    await withServer(undefined, async base => {
      const res = await fetch(`${base}/llm-endpoint/status`)
      expect(res.status).toBe(404)
    })
  })

  it("GET /llm-endpoint/status reports never-started before any start", async () => {
    const registry = makeRegistry()
    await withServer(registry, async base => {
      const res = await fetch(`${base}/llm-endpoint/status`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; running: boolean }
      expect(body.status).toBe("never-started")
      expect(body.running).toBe(false)
    })
  })

  it("GET /llm-endpoint/status reflects a running child", async () => {
    const registry = makeRegistry()
    await withServer(registry, async base => {
      await registry.start({ port: 19101 })
      const res = await fetch(`${base}/llm-endpoint/status`)
      const body = (await res.json()) as { status: string; port: number; owner: string }
      expect(body.status).toBe("running")
      expect(body.port).toBe(19101)
      expect(body.owner).toBe("daemon")
    })
  })

  it("POST /llm-endpoint/restart stops then starts, returning the fresh descriptor", async () => {
    const registry = makeRegistry()
    await withServer(registry, async base => {
      await registry.start({ port: 19102 })
      const res = await fetch(`${base}/llm-endpoint/restart`, { method: "POST" })
      expect(res.status).toBe(200)
      const desc = (await res.json()) as { status: string; port: number }
      expect(desc.status).toBe("running")
      expect(desc.port).toBe(19102)
      expect(registry.launchCalls).toEqual([19102, 19102])
    })
  })

  it("restart PRESERVES the currently-configured port instead of falling back to the default (18090)", async () => {
    const registry = makeRegistry()
    await withServer(registry, async base => {
      // Started on a deliberately non-default port (e.g. LLM_ENDPOINT_PORT
      // at boot, or an explicit llm_endpoint_start port) — a restart must
      // not silently relocate it to the built-in default.
      await registry.start({ port: 19103 })
      await fetch(`${base}/llm-endpoint/restart`, { method: "POST" })
      expect(registry.launchCalls).toEqual([19103, 19103])

      const status = await (await fetch(`${base}/llm-endpoint/status`)).json() as { port: number }
      expect(status.port).toBe(19103)
    })
  })

  it("a never-started registry restarts onto the built-in default port", async () => {
    const registry = makeRegistry()
    await withServer(registry, async base => {
      const res = await fetch(`${base}/llm-endpoint/restart`, { method: "POST" })
      const desc = (await res.json()) as { port: number }
      expect(desc.port).toBe(18090)
    })
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
