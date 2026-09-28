/**
 * `startDeviceSandboxBridge` (DEVICES-PLAN PR-D) — the local loopback HTTP
 * relay the `device` sandbox provider boots so `createSandboxAgentSessionHost`
 * / `sandbox-agent-session-proxy.ts` can plain `fetch()`/MCP-connect to a
 * paired device exactly like any other sandbox's `mcpUrl`. Exercises the
 * real HTTP server with a faked `HostRegistry.forwardHttpStream` — no real
 * pair/v2 tunnel involved (that's `host-registry.test.ts`'s job).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import type { HostRegistry, ForwardHttpRequest, ForwardHttpStreamResponse } from "../host-registry.js"
import { startDeviceSandboxBridge, type DeviceSandboxBridge } from "../device-sandbox-bridge.js"

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe("startDeviceSandboxBridge", () => {
  let bridge: DeviceSandboxBridge | undefined

  afterEach(async () => {
    if (bridge) await bridge.close()
    bridge = undefined
  })

  it("forwards method/path/headers/body to the target via hostRegistry.forwardHttpStream, prefixed with /device-spawn", async () => {
    const forwardHttpStream = vi.fn(
      async (_target: string, _req: ForwardHttpRequest): Promise<ForwardHttpStreamResponse> => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: streamOf(JSON.stringify({ ok: true })),
      }),
    )
    const hostRegistry = { forwardHttpStream } as unknown as HostRegistry

    bridge = await startDeviceSandboxBridge({ hostRegistry, target: "work-mac" })
    const res = await fetch(bridge.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(forwardHttpStream).toHaveBeenCalledTimes(1)
    const [target, req] = forwardHttpStream.mock.calls[0]!
    expect(target).toBe("work-mac")
    expect(req.method).toBe("POST")
    expect(req.path).toBe("/device-spawn/mcp")
    expect(req.headers?.["content-type"]).toBe("application/json")
    expect(JSON.parse(Buffer.from(req.body!).toString("utf8"))).toEqual({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    })
  })

  it("forwards a non-/mcp subpath (e.g. the events stream route) unchanged, just prefixed", async () => {
    const forwardHttpStream = vi.fn(async (): Promise<ForwardHttpStreamResponse> => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: streamOf(": connected\n\n"),
    }))
    const hostRegistry = { forwardHttpStream } as unknown as HostRegistry

    bridge = await startDeviceSandboxBridge({ hostRegistry, target: "work-mac" })
    const base = new URL(bridge.mcpUrl)
    const res = await fetch(
      `http://127.0.0.1:${base.port}/sessions/remote_sess_1/events/stream?since=0`,
    )
    expect(res.status).toBe(200)
    const [, req] = forwardHttpStream.mock.calls[0]!
    expect(req.method).toBe("GET")
    expect(req.path).toBe("/device-spawn/sessions/remote_sess_1/events/stream?since=0")
  })

  it("returns 502 device_unreachable when forwardHttpStream throws", async () => {
    const forwardHttpStream = vi.fn(async () => {
      throw new Error("could not reach host work-mac via wss://rdv.example: dial timed out")
    })
    const hostRegistry = { forwardHttpStream } as unknown as HostRegistry

    bridge = await startDeviceSandboxBridge({ hostRegistry, target: "work-mac" })
    const res = await fetch(bridge.mcpUrl, { method: "POST", body: "{}" })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("device_unreachable")
    expect(body.message).toMatch(/could not reach host/)
  })

  it("close() tears down the local relay server — a subsequent fetch fails to connect", async () => {
    const hostRegistry = {
      forwardHttpStream: vi.fn(async (): Promise<ForwardHttpStreamResponse> => ({
        status: 200,
        headers: {},
        body: streamOf("{}"),
      })),
    } as unknown as HostRegistry

    const b = await startDeviceSandboxBridge({ hostRegistry, target: "work-mac" })
    await b.close()
    bridge = undefined
    await expect(fetch(b.mcpUrl, { method: "POST", body: "{}" })).rejects.toThrow()
  })
})
