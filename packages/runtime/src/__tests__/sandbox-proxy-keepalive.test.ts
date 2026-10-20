/**
 * Sandbox proxy — box lifetime keepalive with FAKE TIMERS.
 *
 * While a turn is in flight the box must be re-armed on a fixed cadence
 * (`BOX_ACTIVE_RENEW_INTERVAL_MS`, 10 min) whether or not it streams
 * anything — event-driven renewal alone misses a turn stuck in one long
 * tool call, and the box then hits its lifetime deadline mid-turn and is
 * reaped. Idle sessions renew nothing (the box is left to expire), and
 * everything stops at `close()`.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createSandboxAgentSessionProxy, BOX_ACTIVE_RENEW_INTERVAL_MS } from "../sandbox-agent-session-proxy.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

const LIFETIME_MS = 45 * 60_000

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

describe("sandbox proxy — lifetime keepalive (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("re-arms the box every 10 minutes while a turn is in flight, even though it streams nothing", async () => {
    vi.useFakeTimers()
    // Unreachable box → the legacy poll fallback; a long-poll that only ever
    // times out is one long tool call the SSE stream never reports on.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("unreachable"))))
    const extendTimeout = vi.fn(async (_ms: number) => {})
    const host = makeHost({
      extendTimeout,
      lifetimeMs: LIFETIME_MS,
      waitForAny: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 49_000))
        return { timedOut: true, sessionIds: [] }
      }),
    })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const turn = (async () => {
      for await (const _evt of proxy.send("go")) {
        // the turn never ends — that is the point
      }
    })()
    await vi.advanceTimersByTimeAsync(BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).toHaveBeenCalledTimes(4)

    await proxy.close().catch(() => undefined)
    void turn.catch(() => undefined)
  })

  it("renews nothing while the session is idle", async () => {
    vi.useFakeTimers()
    const extendTimeout = vi.fn(async (_ms: number) => {})
    const host = makeHost({ extendTimeout, lifetimeMs: LIFETIME_MS })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    await vi.advanceTimersByTimeAsync(3 * BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).not.toHaveBeenCalled()

    await proxy.close().catch(() => undefined)
  })

  it("stops renewing after close()", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("unreachable"))))
    const extendTimeout = vi.fn(async (_ms: number) => {})
    let releasePoll: (() => void) | undefined
    const host = makeHost({
      extendTimeout,
      lifetimeMs: LIFETIME_MS,
      waitForAny: vi.fn(
        () =>
          new Promise<{ timedOut: true; sessionIds: [] }>(resolve => {
            releasePoll = () => resolve({ timedOut: true, sessionIds: [] })
          }),
      ),
    })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })
    const turn = (async () => {
      for await (const _evt of proxy.send("go")) {
        // never yields
      }
    })()
    // Inside the hung poll, a turn IS in flight: the send itself renews, then the first tick.
    await vi.advanceTimersByTimeAsync(BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).toHaveBeenCalledTimes(2)

    await proxy.close().catch(() => undefined)
    extendTimeout.mockClear()
    await vi.advanceTimersByTimeAsync(3 * BOX_ACTIVE_RENEW_INTERVAL_MS)
    expect(extendTimeout).not.toHaveBeenCalled()
    void turn.catch(() => undefined)
  })

  it("needs no keepalive for a provider without extendTimeout — the proxy just never arms it", async () => {
    vi.useFakeTimers()
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })
    expect(proxy.sessionId).toBe("remote_1")
    await vi.advanceTimersByTimeAsync(3 * BOX_ACTIVE_RENEW_INTERVAL_MS)
    await proxy.close().catch(() => undefined)
  })
})
