/**
 * `/device-inference/*` (B, the host exposing its own inference) and
 * `POST /devices/:id/exec-stream/<subpath>` (A, the controller forwarding
 * through a registered host) — DEVICES-PLAN item 1/2's HTTP surface.
 * Exercises the real REST layer via `startHttpServer`, same pattern as
 * llm-endpoint-http-routes.test.ts.
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, HOST_SCOPE_HEADER } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { HostRegistry } from "../host-registry.js"
import type { PairingRegistry } from "../pairing-registry.js"
import {
  LlmEndpointRegistry,
  type EndpointProcess,
  type LaunchOptions,
} from "../llm-endpoint-registry.js"

const EXISTING_BIN = fileURLToPath(import.meta.url)

class MockRegistry extends LlmEndpointRegistry {
  protected override async launch(_opts: LaunchOptions): Promise<EndpointProcess> {
    return { pid: 9001, async stop() {} }
  }
  protected override async probeHealth(): Promise<boolean> {
    return true
  }
}

function makeLlmEndpointRegistry(): MockRegistry {
  return new MockRegistry({
    injectKeys: async () => [],
    injectLinks: async () => [],
    binPath: EXISTING_BIN,
    readyTimeoutMs: 200,
    pollIntervalMs: 5,
  })
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

async function withServer(
  opts: {
    llmEndpoint?: LlmEndpointRegistry
    deviceInferenceShare?: boolean
    pairings?: PairingRegistry
    hostRegistry?: HostRegistry
    token?: string
  },
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
    ...opts,
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("GET/POST /device-inference/* (B: exposing its own inference)", () => {
  it("404s when no llmEndpoint registry is wired", async () => {
    await withServer({ deviceInferenceShare: true }, async base => {
      const res = await fetch(`${base}/device-inference/v1/models`, {
        headers: { [HOST_SCOPE_HEADER]: "1" },
      })
      expect(res.status).toBe(404)
    })
  })

  it("403s without the host-scope header, even with sharing on and the sidecar wired", async () => {
    const registry = makeLlmEndpointRegistry()
    await withServer({ llmEndpoint: registry, deviceInferenceShare: true }, async base => {
      const res = await fetch(`${base}/device-inference/v1/models`)
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("host_scope_required")
    })
  })

  it("403s with the host-scope header when sharing is off", async () => {
    const registry = makeLlmEndpointRegistry()
    await withServer({ llmEndpoint: registry, deviceInferenceShare: false }, async base => {
      const res = await fetch(`${base}/device-inference/v1/models`, {
        headers: { [HOST_SCOPE_HEADER]: "1" },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("sharing_disabled")
    })
  })

  it("proxies GET /v1/models to the local sidecar when scoped + shared", async () => {
    const registry = makeLlmEndpointRegistry()
    const fakeSidecar = createServer((req, res) => {
      expect(req.url).toBe("/v1/models")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "ollama/llama3.1" }] }))
    })
    const sidecarPort = await new Promise<number>(resolvePromise => {
      fakeSidecar.listen(0, "127.0.0.1", () => resolvePromise((fakeSidecar.address() as AddressInfo).port))
    })
    await registry.start({ port: sidecarPort })

    await withServer({ llmEndpoint: registry, deviceInferenceShare: true }, async base => {
      try {
        const res = await fetch(`${base}/device-inference/v1/models`, {
          headers: { [HOST_SCOPE_HEADER]: "1" },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { data: { id: string }[] }
        expect(body.data[0]!.id).toBe("ollama/llama3.1")
      } finally {
        fakeSidecar.close()
      }
    })
  })

  it("strips the host-scope header before proxying to the sidecar (never leaks internally)", async () => {
    const registry = makeLlmEndpointRegistry()
    let sawHeader = false
    const fakeSidecar = createServer((req, res) => {
      sawHeader = req.headers[HOST_SCOPE_HEADER] !== undefined
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [] }))
    })
    const sidecarPort = await new Promise<number>(resolvePromise => {
      fakeSidecar.listen(0, "127.0.0.1", () => resolvePromise((fakeSidecar.address() as AddressInfo).port))
    })
    await registry.start({ port: sidecarPort })

    await withServer({ llmEndpoint: registry, deviceInferenceShare: true }, async base => {
      try {
        await fetch(`${base}/device-inference/v1/models`, { headers: { [HOST_SCOPE_HEADER]: "1" } })
        expect(sawHeader).toBe(false)
      } finally {
        fakeSidecar.close()
      }
    })
  })
})

describe("POST /devices/:id/exec-stream/<subpath> (A: forwarding to a registered host)", () => {
  function fakePairings(): PairingRegistry {
    return {
      createOffer: vi.fn(),
      list: vi.fn(async () => []),
      rename: vi.fn(),
      revoke: vi.fn(),
      isOnline: () => false,
      startAutoconnect: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as PairingRegistry
  }

  it("404s when no hostRegistry is wired", async () => {
    await withServer({ pairings: fakePairings() }, async base => {
      const res = await fetch(`${base}/devices/some-host/exec-stream/device-inference/v1/models`, {
        method: "POST",
        headers: { "x-agentproto-forward-method": "GET" },
      })
      expect(res.status).toBe(404)
    })
  })

  it("400s without a valid x-agentproto-forward-method header", async () => {
    const hostRegistry = { forwardHttpStream: vi.fn() } as unknown as HostRegistry
    await withServer({ pairings: fakePairings(), hostRegistry, token: "boot-token" }, async base => {
      const res = await fetch(`${base}/devices/some-host/exec-stream/device-inference/v1/models`, {
        method: "POST",
        headers: { authorization: "Bearer boot-token" },
      })
      expect(res.status).toBe(400)
    })
  })

  it("requires the bearer token — the outer verb is always POST so there is no GET bypass", async () => {
    const hostRegistry = { forwardHttpStream: vi.fn() } as unknown as HostRegistry
    await withServer({ pairings: fakePairings(), hostRegistry, token: "boot-token" }, async base => {
      const res = await fetch(`${base}/devices/some-host/exec-stream/device-inference/v1/models`, {
        method: "POST",
        headers: { "x-agentproto-forward-method": "GET" },
      })
      expect(res.status).toBe(401)
    })
  })

  it("forwards via hostRegistry.forwardHttpStream and relays the streamed response", async () => {
    const forwardHttpStream = vi.fn(
      async (_target: string, _req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array }) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: streamOf(JSON.stringify({ ok: true })),
      }),
    )
    const hostRegistry = { forwardHttpStream } as unknown as HostRegistry
    await withServer({ pairings: fakePairings(), hostRegistry, token: "boot-token" }, async base => {
      const res = await fetch(`${base}/devices/work-mac/exec-stream/device-inference/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer boot-token",
          "x-agentproto-forward-method": "POST",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "ollama/llama3.1", messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(forwardHttpStream).toHaveBeenCalledTimes(1)
      const [target, req] = forwardHttpStream.mock.calls[0]!
      expect(target).toBe("work-mac")
      expect(req.method).toBe("POST")
      expect(req.path).toBe("/device-inference/v1/chat/completions")
      expect(JSON.parse(Buffer.from(req.body!).toString("utf8"))).toEqual({ model: "ollama/llama3.1", messages: [] })
    })
  })

  it("502s with a clear message when the host is unreachable", async () => {
    const forwardHttpStream = vi.fn(async () => {
      throw new Error("could not reach host abc123 via wss://rdv.example: dial timed out")
    })
    const hostRegistry = { forwardHttpStream } as unknown as HostRegistry
    await withServer({ pairings: fakePairings(), hostRegistry, token: "boot-token" }, async base => {
      const res = await fetch(`${base}/devices/work-mac/exec-stream/device-inference/v1/models`, {
        method: "POST",
        headers: { authorization: "Bearer boot-token", "x-agentproto-forward-method": "GET" },
      })
      expect(res.status).toBe(502)
      const body = (await res.json()) as { message: string }
      expect(body.message).toMatch(/could not reach host/)
    })
  })
})

// ── tiny stubs (mirror llm-endpoint-http-routes.test.ts) ──

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
