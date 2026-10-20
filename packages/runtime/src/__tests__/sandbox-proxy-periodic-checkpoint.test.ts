/**
 * Sandbox proxy — periodic in-turn checkpoint trigger (FAKE TIMERS).
 *
 * The periodic timer (`on: ["interval"]`, `checkpoint.periodic`) must take a
 * checkpoint every `intervalMs` DURING a turn — a turn longer than the box
 * lifetime otherwise ends with the box reaped and nothing snapshot since
 * turn-end. The per-turn hook (`on: ["turn-end"]`, `checkpoint.onTurnEnd`)
 * is the separate, event-based trigger.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

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
    ...overrides,
  }
}

/** SSE stream yielding one turn-end — a complete, instantly-finished turn. */
function turnEndResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ seq: 1, ts: "t", kind: "turn-end", reason: "completed" })}\n\n`))
      controller.close()
    },
  })
  return new Response(body)
}

async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const evt of iter) out.push(evt)
  return out
}

describe("sandbox proxy — periodic in-turn checkpoint (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("periodic: true checkpoints every intervalMs, mid-turn included", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("unreachable"))))
    const checkpoint = vi.fn(async () => ({}))
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({
        waitForAny: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 49_000))
          return { timedOut: true, sessionIds: [] }
        }),
      }),
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: true, onTurnEnd: false },
    })
    // A turn that never ends: the periodic timer must still checkpoint mid-turn.
    void collect(proxy.send("long build")).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(checkpoint).toHaveBeenCalledWith(1, undefined)
    await vi.advanceTimersByTimeAsync(2 * 10 * 60_000)
    expect(checkpoint).toHaveBeenCalledTimes(3)
    await proxy.close().catch(() => undefined)
  })

  it("onTurnEnd: true checkpoints after each turn; onTurnEnd: false never does", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => turnEndResponse()))
    const checkpoint = vi.fn(async () => ({}))
    const host = makeHost()
    const on = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: false, onTurnEnd: true },
    })
    await collect(on.send("go"))
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(1, undefined)
    await on.close().catch(() => undefined)

    const offCheckpoint = vi.fn(async () => ({}))
    const off = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_2",
      checkpoint: { run: offCheckpoint, intervalMs: 10 * 60_000, periodic: false, onTurnEnd: false },
    })
    await collect(off.send("go"))
    // only the periodic timer would checkpoint now, and it is off
    await vi.advanceTimersByTimeAsync(3 * 10 * 60_000)
    expect(offCheckpoint).not.toHaveBeenCalled()
    await off.close().catch(() => undefined)
  })

  it("periodic: false never starts the interval timer", async () => {
    vi.useFakeTimers()
    const checkpoint = vi.fn(async () => ({}))
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: false, onTurnEnd: false },
    })
    await vi.advanceTimersByTimeAsync(3 * 10 * 60_000)
    expect(checkpoint).not.toHaveBeenCalled()
    await proxy.close().catch(() => undefined)
  })
})
