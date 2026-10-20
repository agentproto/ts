/**
 * Sandbox proxy — heartbeat renewal + pre-deadline guard.
 *
 * Event-driven renewal (sandbox-proxy-renew.test.ts) misses a turn that
 * streams nothing for a long time: sess_07610979 (2026-10-13) ran one busy
 * turn into its box's 45-min deadline, and the checkpoint probe only ran
 * after the box was gone. While a turn is in flight the proxy now re-arms the
 * box every BOX_ACTIVE_RENEW_INTERVAL_MS, and ahead of the known deadline it
 * either renews one last time or runs a final checkpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BOX_ACTIVE_RENEW_INTERVAL_MS,
  BOX_DEADLINE_GUARD_LEAD_MS,
  createSandboxAgentSessionProxy,
} from "../sandbox-agent-session-proxy.js"
import type { AgentStreamEvent } from "../sessions.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

const LIFETIME_MS = 45 * 60_000
const MINUTE = 60_000

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
    lifetimeMs: LIFETIME_MS,
    ...overrides,
  }
}

/** An SSE body that stays open (a busy turn streaming nothing) until `end()`
 *  delivers the turn-end. */
function openTurnStream(): { response: Response; end: () => void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
      c.enqueue(new TextEncoder().encode(": connected\n\n"))
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    end: () => {
      const rec = { seq: 1, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" }
      ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(rec)}\n\n`))
      ctrl.close()
    },
  }
}

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

describe("sandbox proxy — heartbeat renewal and deadline guard", () => {
  let stream: ReturnType<typeof openTurnStream>

  beforeEach(() => {
    vi.useFakeTimers()
    stream = openTurnStream()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream.response),
    )
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("re-arms the box on a fixed cadence through a busy turn that streams nothing", async () => {
    const extendTimeout = vi.fn(async () => {})
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout }),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    const turn = collect(proxy.send("long build"))
    await vi.advanceTimersByTimeAsync(0)
    expect(extendTimeout).toHaveBeenCalledTimes(1) // prompt dispatch

    // Two hours of silence, well past the original 45-min deadline.
    await vi.advanceTimersByTimeAsync(120 * MINUTE)
    expect(extendTimeout).toHaveBeenCalledTimes(1 + 120 * MINUTE / BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).toHaveBeenLastCalledWith(LIFETIME_MS)
    // Every renewal succeeded, so the guard never had to checkpoint.
    expect(checkpoint.run).not.toHaveBeenCalled()

    stream.end()
    expect((await turn).at(-1)).toEqual({ kind: "turn-end", reason: "completed" })
    await proxy.close()
  })

  it("checkpoints before the deadline when the re-arm fails", async () => {
    const extendTimeout = vi.fn(async () => {
      throw new Error("Sandbox is probably not running anymore")
    })
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout }),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    void collect(proxy.send("long build")).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(LIFETIME_MS - BOX_DEADLINE_GUARD_LEAD_MS - 1)
    expect(checkpoint.run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    // One last renewal attempt from the guard, then the final checkpoint —
    // still BEFORE the deadline. The guard RETRIES the renewal (up to 5
    // spaced sleeps of ≤30s settle into fake time) before falling through
    // to the checkpoint; advance through those sleeps without reaching the
    // 45-min deadline itself.
    await vi.advanceTimersByTimeAsync(5 * 30_000)
    expect(extendTimeout.mock.calls.length).toBeGreaterThan(1)
    expect(checkpoint.run).toHaveBeenCalledTimes(1)
    // The final checkpoint is BOUNDED to the remaining lifetime (the guard
    // runs early, so a positive budget is always passed).
    expect(checkpoint.run).toHaveBeenCalledWith(1, expect.objectContaining({ deadlineMs: expect.any(Number) }))

    stream.end()
    await proxy.close()
  })

  it("an idle box gets a final checkpoint ahead of its deadline, never a renewal", async () => {
    const extendTimeout = vi.fn(async () => {})
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout }),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    await vi.advanceTimersByTimeAsync(LIFETIME_MS - BOX_DEADLINE_GUARD_LEAD_MS)

    expect(extendTimeout).not.toHaveBeenCalled()
    expect(checkpoint.run).toHaveBeenCalledTimes(1)

    // The guard fires once per deadline; nothing more once the box is gone.
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE)
    expect(checkpoint.run).toHaveBeenCalledTimes(1)
    await proxy.close()
  })

  it("an accepted renewal pushes the guard out with the new deadline", async () => {
    const extendTimeout = vi.fn(async () => {})
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout }),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    const turn = collect(proxy.send("go")) // renews at t=20min → deadline t=65min
    await vi.advanceTimersByTimeAsync(0)
    stream.end()
    await turn
    checkpoint.run.mockClear() // the turn-end checkpoint

    // Past the ORIGINAL guard time (t=40min): nothing.
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(checkpoint.run).not.toHaveBeenCalled()
    // The new guard fires at t=60min (65 − lead).
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(checkpoint.run).toHaveBeenCalledTimes(1)
    await proxy.close()
  })

  it("close() stops the heartbeat and the guard", async () => {
    const extendTimeout = vi.fn(async () => {})
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout }),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    void collect(proxy.send("go")).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    await proxy.close()
    extendTimeout.mockClear()
    checkpoint.run.mockClear()

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE)
    expect(extendTimeout).not.toHaveBeenCalled()
    expect(checkpoint.run).not.toHaveBeenCalled()
  })

  it("detach() stops both; the detached lifetime extension keeps its own logic", async () => {
    const extendTimeout = vi.fn(async () => {})
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ extendTimeout, close: vi.fn(async () => {}) }),
      remoteSessionId: "remote_1",
      checkpoint,
      detachable: true,
    })

    void collect(proxy.send("go"))
    await vi.advanceTimersByTimeAsync(0)
    proxy.detach!()
    await proxy.extendDetachedLifetime!()
    expect(extendTimeout).toHaveBeenLastCalledWith(60 * MINUTE)
    extendTimeout.mockClear()

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE)
    expect(extendTimeout).not.toHaveBeenCalled()
    expect(checkpoint.run).not.toHaveBeenCalled()
  })

  it("is inert for a provider without extendTimeout", async () => {
    const checkpoint = { run: vi.fn(async () => {}), intervalMs: 24 * 60 * MINUTE }
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      checkpoint,
    })

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE)
    expect(checkpoint.run).not.toHaveBeenCalled()
    await proxy.close()
  })
})
