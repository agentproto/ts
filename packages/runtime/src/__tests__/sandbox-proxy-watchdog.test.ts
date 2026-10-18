/**
 * Sandbox proxy — box-daemon watchdog and periodic checkpoints.
 *
 * The incident: a box's daemon was OOM-killed BETWEEN turns. Nothing read the
 * box until the next prompt, the host row stayed `running`, and the work in
 * the box (never delivered: `close()` never ran) was lost. The watchdog turns
 * a dead daemon into an `onDisconnect` (→ the registry's crash path), with a
 * last checkpoint first; checkpoints also run on a timer and at each turn end.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  createSandboxAgentSessionProxy,
  isSandboxBoxExpiredError,
  probeBoxDaemonHealth,
  type BoxLiveness,
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

function sequence(results: BoxLiveness[]): () => Promise<BoxLiveness> {
  let i = 0
  return async () => results[Math.min(i++, results.length - 1)] ?? "alive"
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("sandbox proxy — watchdog", () => {
  it("declares the box dead after the failure threshold, checkpoints first, then fires onDisconnect", async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      checkpoint: {
        run: async () => {
          order.push("checkpoint")
        },
        intervalMs: 10 * 60_000,
      },
      watchdog: { probe: sequence(["alive", "dead", "dead", "dead"]), intervalMs: 1_000, failureThreshold: 3 },
    })
    const errors: Error[] = []
    proxy.onDisconnect?.(err => {
      order.push("disconnect")
      errors.push(err)
    })
    expect(proxy.isConnected?.()).toBe(true)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(errors).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/failed its health check 3 times/)
    expect(order).toEqual(["checkpoint", "disconnect"])
    expect(proxy.isConnected?.()).toBe(false)
    // A listener attached after death fires at once.
    const late = vi.fn()
    proxy.onDisconnect?.(late)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it("an answer resets the streak, and host-side network errors never count", async () => {
    vi.useFakeTimers()
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      watchdog: {
        probe: sequence(["dead", "dead", "alive", "dead", "inconclusive", "inconclusive", "dead", "alive"]),
        intervalMs: 1_000,
        failureThreshold: 3,
      },
    })
    const listener = vi.fn()
    proxy.onDisconnect?.(listener)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listener).not.toHaveBeenCalled()
    await proxy.close()
  })

  it("a box that stops answering at all (thrashing, no swap) is dead after the unresponsive threshold", async () => {
    vi.useFakeTimers()
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      watchdog: { probe: async () => "unresponsive", intervalMs: 1_000, unresponsiveThreshold: 4 },
    })
    const listener = vi.fn()
    proxy.onDisconnect?.(listener)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].message).toMatch(/did not answer its health check 4 times/)
  })

  it("close() stops the watchdog: an orderly teardown is never reported as a death", async () => {
    vi.useFakeTimers()
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      watchdog: { probe: async () => "dead", intervalMs: 1_000, failureThreshold: 1 },
    })
    const listener = vi.fn()
    proxy.onDisconnect?.(listener)
    await proxy.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(listener).not.toHaveBeenCalled()
  })

  it("without a watchdog the proxy exposes no liveness surface (byte-identical for device spawns)", () => {
    const proxy = createSandboxAgentSessionProxy({ host: makeHost(), remoteSessionId: "remote_1" })
    expect(proxy.onDisconnect).toBeUndefined()
    expect(proxy.isConnected).toBeUndefined()
  })
})

describe("sandbox proxy — watchdog expiry classification", () => {
  const LIFETIME_MS = 45 * 60_000

  function expiryHost(): FakeHost {
    return {
      ...makeHost(),
      extendTimeout: vi.fn(async () => {}),
      lifetimeMs: LIFETIME_MS,
    }
  }

  /** `vi.useFakeTimers()` does not pin the fake clock to 0 — Date starts at
   *  the real wall time — so a probe comparing `Date.now()` against the raw
   *  LIFETIME_MS constant fires nonsense (an epoch is always > 2.7e6). All
   *  expiry probes must anchor on the fake clock's t0 captured at setup. */
  function atPast(anchor: number, delta: number = 0): () => Promise<BoxLiveness> {
    return async () => (Date.now() >= anchor + delta ? "dead" : "alive")
  }

  /** An idle box whose work is delivered: the deadline guard checkpointed
   *  ahead of the deadline, nothing re-arms, the box is reaped exactly at
   *  its lifetime — the watchdog declaring death THEN tags the error as
   *  expected expiry, not a crash (sess_795b8c58 / e39cd4da / 7d29436b). */
  it("a box dying at/past its lifetime deadline while idle is reported as expected expiry", async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const proxy = createSandboxAgentSessionProxy({
      host: expiryHost(),
      remoteSessionId: "remote_1",
      checkpoint: { run: async () => {}, intervalMs: 10 * 60_000 },
      // The box answers healthily until its lifetime runs out, then the
      // provider has reaped it — every probe is definitive from there.
      watchdog: {
        probe: atPast(t0, LIFETIME_MS),
        intervalMs: 30_000,
        failureThreshold: 3,
      },
    })
    const errors: Error[] = []
    proxy.onDisconnect?.(err => errors.push(err))
    // Past the deadline: the guard already ran its final checkpoint, the box
    // is gone, and three dead probes (~90s of interval) in a row declare it.
    await vi.advanceTimersByTimeAsync(LIFETIME_MS + 5 * 60_000)
    expect(errors).toHaveLength(1)
    expect(isSandboxBoxExpiredError(errors[0])).toBe(true)
    expect(errors[0]?.message).toMatch(/lifetime deadline.*expected expiry/)
    await proxy.close()
  })

  it("a box dying BEFORE its deadline is still a crash, even with lifetime tracking on", async () => {
    vi.useFakeTimers()
    const proxy = createSandboxAgentSessionProxy({
      host: expiryHost(),
      remoteSessionId: "remote_1",
      watchdog: { probe: async () => "dead", intervalMs: 1_000, failureThreshold: 2 },
    })
    const errors: Error[] = []
    proxy.onDisconnect?.(err => errors.push(err))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(errors).toHaveLength(1)
    expect(isSandboxBoxExpiredError(errors[0])).toBe(false)
    expect(errors[0]?.message).toMatch(/failed its health check 2 times/)
    await proxy.close()
  })

  /** A turn in flight keeps renewing the box: the expiry classification must
   *  travel with the pushed-out deadline, so a box dying past the ORIGINAL
   *  deadline but BEFORE the renewed one (a mid-turn death — machine reclaimed
   *  early) stays a crash, not an expected expiry. */
  it("an accepted renewal pushes the expiry classification out with the new deadline", async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    // A stream that stays open until we end it — the turn keeps the proxy's
    // heartbeat renewal running for as long as the box stays reachable.
    let endTurn: () => void = () => {}
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(": connected\n\n"))
          endTurn = () => {
            c.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ seq: 1, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" })}\n\n`,
            ))
            c.close()
          }
        },
      })
      return new Response(body, { status: 200 })
    }))
    const proxy = createSandboxAgentSessionProxy({
      host: expiryHost(),
      remoteSessionId: "remote_1",
      checkpoint: { run: async () => {}, intervalMs: 10 * 60_000 },
      watchdog: {
        // The box dies between the OLD deadline (t0+45m — already pushed out
        // by active renewal) and the renewed one (t0+90m).
        probe: atPast(t0, 50 * 60_000),
        intervalMs: 30_000,
        failureThreshold: 3,
      },
    })
    const errors: Error[] = []
    proxy.onDisconnect?.(err => errors.push(err))
    // Half the first runway with a turn in flight: its heartbeat renews the
    // box on the fixed cadence, so death past the ORIGINAL deadline (now
    // pushed out) must not read as expiry.
    void collectEvents(proxy, "go")
    await vi.advanceTimersByTimeAsync(LIFETIME_MS + 7 * 60_000)
    // The box died past its original deadline (t0+45m, long pushed out by
    // the heartbeat renewals) — a MID-TURN death, still under the renewed
    // deadline (t0+90m): classified as a crash, exactly as before.
    expect(errors).toHaveLength(1)
    expect(isSandboxBoxExpiredError(errors[0])).toBe(false)
    endTurn()
    await proxy.close()
    vi.unstubAllGlobals()
  })
})

async function collectEvents(
  proxy: ReturnType<typeof createSandboxAgentSessionProxy>,
  message: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const ev of proxy.send(message)) void ev
  } catch {
    // the box stream never opens under fake timers — fine for this test
  }
}

describe("probeBoxDaemonHealth", () => {
  it("probes /health on the mcpUrl origin and classifies the answer", async () => {
    const urls: string[] = []
    let status = 200
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      urls.push(String(url))
      return new Response("ok", { status })
    }))
    expect(await probeBoxDaemonHealth("https://18790-box.e2b.app/mcp?x=1")).toBe("alive")
    expect(urls[0]).toBe("https://18790-box.e2b.app/health")
    status = 502
    expect(await probeBoxDaemonHealth("https://18790-box.e2b.app/mcp")).toBe("dead")
  })

  it("a timeout is unresponsive, any other fetch failure is inconclusive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }))
    expect(await probeBoxDaemonHealth("https://18790-box.e2b.app/mcp")).toBe("unresponsive")
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed")
    }))
    expect(await probeBoxDaemonHealth("https://18790-box.e2b.app/mcp")).toBe("inconclusive")
  })
})

describe("sandbox proxy — checkpoints", () => {
  it("checkpoints on the timer and after each turn, never two at once", async () => {
    let running = 0
    let maxConcurrent = 0
    const run = vi.fn(async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise(resolve => setTimeout(resolve, 60))
      running--
    })
    // No SSE route: the turn takes the legacy poll path, which settles at once.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })))
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      checkpoint: { run, intervalMs: 40 },
    })

    const events: AgentStreamEvent[] = []
    for await (const ev of proxy.send("go")) events.push(ev)
    expect(events.at(-1)).toMatchObject({ kind: "turn-end" })
    expect(run).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 })
    expect(maxConcurrent).toBe(1)
    await proxy.close()
    const calls = run.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(run.mock.calls.length).toBe(calls)
  })

  it("close() waits for an in-flight checkpoint before the teardown delivery, then stops the timer", async () => {
    vi.useFakeTimers()
    const order: string[] = []
    let release: () => void = () => undefined
    const run = vi.fn(
      () =>
        new Promise<void>(resolve => {
          order.push("checkpoint:start")
          release = () => {
            order.push("checkpoint:end")
            resolve()
          }
        }),
    )
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      checkpoint: { run, intervalMs: 1_000 },
      onBeforeTeardown: async () => {
        order.push("delivery")
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    const closing = proxy.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(["checkpoint:start"])
    release()
    await closing
    expect(order).toEqual(["checkpoint:start", "checkpoint:end", "delivery"])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
