import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RelayConfig } from "./config.js"
import { createRateLimiter } from "./rate-limiter.js"
import { createRelayServer, type DaemonClient } from "./server.js"

const BASE_CONFIG: RelayConfig = {
  targetSession: "my-session",
  targetVia: "agent",
  token: "secret-token",
  daemonUrl: "http://daemon.local",
  rateLimit: { max: 100, windowMs: 60_000 },
}

function makeDaemonClient(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    checkSessionAlive: vi.fn(async () => ({ ok: true, id: "sess_abc", status: "running" })),
    resolveDaemonToken: vi.fn(async () => "daemon-token"),
    sendAgentPrompt: vi.fn(async () => ({ ok: true, status: 202 })),
    sendTerminalInput: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

interface Harness {
  baseUrl: string
  close: () => Promise<void>
}

async function startServer(
  config: RelayConfig,
  daemonClient: DaemonClient,
  rateLimiter = createRateLimiter(config.rateLimit),
): Promise<Harness> {
  const server = createRelayServer({ config, daemonClient, rateLimiter })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}

describe("relay server", () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it("GET /relay/health requires no auth and returns ok", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("404s on unknown routes", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  it("rejects POST /relay/inbound with no Authorization header", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects POST /relay/inbound with the wrong token", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ text: "hi" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects a body missing `text`", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ notText: "hi" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("missing_text")
  })

  it("rejects a body with an empty `text`", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ text: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects invalid JSON bodies", async () => {
    harness = await startServer(BASE_CONFIG, makeDaemonClient())
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
  })

  it("ignores extra fields and only reads top-level `text`", async () => {
    const daemonClient = makeDaemonClient()
    harness = await startServer(BASE_CONFIG, daemonClient)
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ text: "hello", from: "someone", metadata: { a: 1 } }),
    })
    expect(res.status).toBe(202)
    expect(daemonClient.sendAgentPrompt).toHaveBeenCalledWith(
      "http://daemon.local",
      "sess_abc",
      "hello",
      "daemon-token",
    )
  })

  it("returns 502 when the target session is dead or missing", async () => {
    const daemonClient = makeDaemonClient({
      checkSessionAlive: vi.fn(async () => ({ ok: false, reason: "no session" })),
    })
    harness = await startServer(BASE_CONFIG, daemonClient)
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe("target_session_unavailable")
    expect(daemonClient.sendAgentPrompt).not.toHaveBeenCalled()
  })

  it("routes to sendTerminalInput when targetVia is terminal", async () => {
    const daemonClient = makeDaemonClient()
    harness = await startServer({ ...BASE_CONFIG, targetVia: "terminal" }, daemonClient)
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(res.status).toBe(202)
    expect(daemonClient.sendTerminalInput).toHaveBeenCalledWith(
      "http://daemon.local",
      "sess_abc",
      "hello",
      "daemon-token",
    )
    expect(daemonClient.sendAgentPrompt).not.toHaveBeenCalled()
  })

  it("surfaces a delivery failure as a 502", async () => {
    const daemonClient = makeDaemonClient({
      sendAgentPrompt: vi.fn(async () => ({ ok: false, message: "session busy" })),
    })
    harness = await startServer(BASE_CONFIG, daemonClient)
    const res = await fetch(`${harness.baseUrl}/relay/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe("relay_delivery_failed")
  })

  it("enforces the rate limit", async () => {
    const rateLimiter = createRateLimiter({ max: 1, windowMs: 60_000 })
    harness = await startServer(BASE_CONFIG, makeDaemonClient(), rateLimiter)
    const send = () =>
      fetch(`${harness!.baseUrl}/relay/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
        body: JSON.stringify({ text: "hello" }),
      })
    const first = await send()
    expect(first.status).toBe(202)
    const second = await send()
    expect(second.status).toBe(429)
  })

  it("rate limits even unauthenticated requests", async () => {
    const rateLimiter = createRateLimiter({ max: 1, windowMs: 60_000 })
    harness = await startServer(BASE_CONFIG, makeDaemonClient(), rateLimiter)
    const send = () =>
      fetch(`${harness!.baseUrl}/relay/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      })
    const first = await send()
    expect(first.status).toBe(401)
    const second = await send()
    expect(second.status).toBe(429)
  })
})
