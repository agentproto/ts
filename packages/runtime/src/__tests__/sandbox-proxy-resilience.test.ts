/**
 * Sandbox proxy — transient-failure tolerance in the turn poll loop.
 *
 * A single failed poll request must NOT kill a healthy turn: a long review
 * turn saturates a small box (monorepo clone + model generation), stalling
 * its daemon past the client's per-request timeout (`MCP error -32001`,
 * observed live in CI ~2min into the reviewer's turn). The proxy retries
 * transient poll failures and only gives up after
 * MAX_CONSECUTIVE_POLL_FAILURES in a row; a failed output pull is
 * best-effort (offset-diff loses nothing) and never fails a settled turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"
import type { AgentStreamEvent } from "../sessions.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    stop: vi.fn(async () => {}),
    ...overrides,
  }
}

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

describe("sandbox proxy — poll resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("survives transient poll failures (MCP -32001) and completes the turn", async () => {
    const waitForAny = vi
      .fn()
      .mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"))
      .mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"))
      .mockResolvedValueOnce({ timedOut: false, event: "turn-end", sessionIds: [] })
    const output = vi.fn(async () => "BOX OUTPUT\n")
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const done = collect(proxy.send("go"))
    // Two retry delays (5s each) stand between the failures and the settle.
    await vi.advanceTimersByTimeAsync(15_000)
    const events = await done

    expect(waitForAny).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      { kind: "text-delta", text: "BOX OUTPUT\n" },
      { kind: "turn-end", reason: "completed" },
    ])
  })

  it("gives up loudly after sustained poll failures, carrying the last error", async () => {
    const waitForAny = vi.fn(async () => {
      throw new Error("MCP error -32001: Request timed out")
    })
    const host = makeHost({ waitForAny })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const done = collect(proxy.send("go")).then(
      () => {
        throw new Error("expected the turn to fail")
      },
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await done

    expect(String(err)).toMatch(/consecutive poll failures/)
    expect(String(err)).toMatch(/-32001/)
    expect(waitForAny).toHaveBeenCalledTimes(6)
  })

  it("a failed output pull never fails a settled turn (best-effort, offset-diff safe)", async () => {
    const waitForAny = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: false, event: "turn-end", sessionIds: [] })
    const output = vi.fn(async () => {
      throw new Error("MCP error -32001: Request timed out")
    })
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    // Initial pull + settle retry — both failed, turn still completes.
    expect(output).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ kind: "turn-end", reason: "completed" }])
  })

  it("a clean long-poll timeout keeps polling without counting as a failure", async () => {
    const waitForAny = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: true, sessionIds: [] })
      .mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"))
      .mockResolvedValueOnce({ timedOut: true, sessionIds: [] })
      .mockResolvedValueOnce({ timedOut: false, event: "turn-end", sessionIds: [] })
    const output = vi.fn(async () => "done\n")
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const done = collect(proxy.send("go"))
    await vi.advanceTimersByTimeAsync(10_000)
    const events = await done

    expect(waitForAny).toHaveBeenCalledTimes(4)
    expect(events[events.length - 1]).toEqual({ kind: "turn-end", reason: "completed" })
  })
})
