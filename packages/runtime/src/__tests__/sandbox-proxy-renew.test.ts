/**
 * Sandbox proxy — box lifetime renewal while the session is working.
 *
 * A provider box has a hard TTL; nothing used to re-arm it during activity,
 * so a box mid-work could be reaped. The proxy now calls
 * `host.extendTimeout(lifetime)` when a prompt is dispatched and as box
 * events stream back — throttled, fire-and-forget, never while idle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BOX_RENEW_THROTTLE_MS,
  DEFAULT_BOX_RENEW_LIFETIME_MS,
  createSandboxAgentSessionProxy,
} from "../sandbox-agent-session-proxy.js"
import type { AgentStreamEvent } from "../sessions.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
}

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

function sseResponse(records: Array<Record<string, unknown>>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(": connected\n\n"))
      for (const rec of records) controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const TURN = [
  { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "a\n" },
  { seq: 2, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "b\n" },
  { seq: 3, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
]

describe("sandbox proxy — box lifetime renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(TURN)),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("renews with the box's configured lifetime when a prompt is dispatched", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout, lifetimeMs: 10 * 60_000 })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    await collect(proxy.send("go"))

    expect(extendTimeout).toHaveBeenCalledTimes(1)
    expect(extendTimeout).toHaveBeenCalledWith(10 * 60_000)
  })

  it("falls back to the default lifetime when the host reports none", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    await collect(proxy.send("go"))

    expect(extendTimeout).toHaveBeenCalledWith(DEFAULT_BOX_RENEW_LIFETIME_MS)
  })

  it("renews at most once per throttle window, again once it elapses", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    // Prompt dispatch + several streamed records, all inside one window.
    await collect(proxy.send("one"))
    expect(extendTimeout).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BOX_RENEW_THROTTLE_MS - 1_000)
    await collect(proxy.send("two"))
    expect(extendTimeout).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await collect(proxy.send("three"))
    expect(extendTimeout).toHaveBeenCalledTimes(2)
  })

  it("renews on streamed events, not just on prompt dispatch", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout })
    // The first turn rode the spawn dial: no prompt is sent, only the stream is read.
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      promptCarriedInStart: true,
    })

    await collect(proxy.send("go"))

    expect(host.prompt).not.toHaveBeenCalled()
    expect(extendTimeout).toHaveBeenCalledTimes(1)
  })

  it("never renews while idle", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout })
    createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1", detachable: true })

    vi.advanceTimersByTime(3 * 60 * 60_000)
    await Promise.resolve()

    expect(extendTimeout).not.toHaveBeenCalled()
  })

  it("does not renew for the stale backlog of an idle re-attach replay", async () => {
    const extendTimeout = vi.fn(async () => {})
    const host = makeHost({ extendTimeout })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      detachable: true,
    })

    await collect(proxy.resumeTurn!())

    expect(extendTimeout).not.toHaveBeenCalled()
  })

  it("a rejecting extendTimeout is logged and does not break the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const extendTimeout = vi.fn(async () => {
      throw new Error("Timeout cannot be greater than 1 hours")
    })
    const host = makeHost({ extendTimeout })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))
    await Promise.resolve()

    expect(events.map(e => e.kind)).toEqual(["text-delta", "text-delta", "turn-end"])
    expect(extendTimeout).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("a synchronously throwing extendTimeout does not break the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const extendTimeout = vi.fn(() => {
      throw new Error("boom")
    }) as unknown as NonNullable<FakeHost["extendTimeout"]>
    const host = makeHost({ extendTimeout })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events.at(-1)).toEqual({ kind: "turn-end", reason: "completed" })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("is a no-op for a provider without extendTimeout", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events.at(-1)).toEqual({ kind: "turn-end", reason: "completed" })
  })
})
