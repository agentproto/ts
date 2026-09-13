/**
 * Sandbox proxy — structured event-stream fidelity.
 *
 * `send()` prefers the box daemon's `GET /sessions/:id/events/stream` SSE
 * route over the legacy `agent_output` poll: it yields the SAME
 * `AgentStreamEvent` shape (thought/tool-call/tool-result/usage_update/
 * turn-end) a LOCAL adapter's own stream produces, instead of flattening
 * everything into `text-delta` lines. See `sandbox-proxy-resilience.test.ts`
 * for the fallback poll loop's own resilience (retries, exited-detection) —
 * this file covers (a) the happy path over SSE and (b) falling back to that
 * legacy loop when the route is unreachable/404s.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"
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

/** Build a `Response` whose body streams `records` as `data: <json>\n\n`
 *  SSE frames — the exact framing `GET /sessions/:id/events/stream` emits
 *  (http-server.ts). One frame per `res.write`, matching how the real
 *  route flushes each record as its own chunk. */
function sseResponse(records: Array<Record<string, unknown>>, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(": connected\n\n"))
      for (const rec of records) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(status === 200 ? body : null, { status })
}

describe("sandbox proxy — structured SSE stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("yields structured events (thought/tool-call/tool-result/usage_update/text-delta) matching a local adapter's shape, then turn-end", async () => {
    const records = [
      { seq: 1, ts: "t", kind: "user-prompt", sessionId: "remote_1", text: "go" },
      { seq: 2, ts: "t", kind: "thought", sessionId: "remote_1", text: "thinking...\n" },
      {
        seq: 3,
        ts: "t",
        kind: "tool-call",
        sessionId: "remote_1",
        toolCallId: "tc1",
        toolName: "Bash",
        arguments: { command: "ls" },
      },
      {
        seq: 4,
        ts: "t",
        kind: "tool-result",
        sessionId: "remote_1",
        toolCallId: "tc1",
        result: "file.txt",
        isError: false,
      },
      {
        seq: 5,
        ts: "t",
        kind: "usage_update",
        sessionId: "remote_1",
        size: 200_000,
        used: 1_234,
        tokensIn: 1000,
        tokensOut: 234,
      },
      { seq: 6, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "done\n" },
      { seq: 7, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
    ]
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      expect(url.pathname).toBe("/sessions/remote_1/events/stream")
      expect(url.searchParams.get("since")).toBe("0")
      return sseResponse(records)
    })
    vi.stubGlobal("fetch", fetchMock)

    const waitForAny = vi.fn()
    const output = vi.fn()
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      { kind: "thought", text: "thinking...\n" },
      { kind: "tool-call", toolCallId: "tc1", toolName: "Bash", arguments: { command: "ls" } },
      { kind: "tool-result", toolCallId: "tc1", result: "file.txt", isError: false },
      { kind: "usage_update", size: 200_000, used: 1_234, tokensIn: 1000, tokensOut: 234 },
      { kind: "text-delta", text: "done\n" },
      { kind: "turn-end", reason: "completed" },
    ])
    // The legacy poll path is never touched when the structured stream works.
    expect(waitForAny).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("advances the per-session transcript cursor across turns so a later turn only replays what's new", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (input: string | URL) => {
        expect(new URL(input).searchParams.get("since")).toBe("0")
        return sseResponse([
          { seq: 1, ts: "t", kind: "user-prompt", sessionId: "remote_1", text: "go" },
          { seq: 2, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ])
      })
      .mockImplementationOnce(async (input: string | URL) => {
        expect(new URL(input).searchParams.get("since")).toBe("2")
        return sseResponse([
          { seq: 3, ts: "t", kind: "user-prompt", sessionId: "remote_1", text: "again" },
          { seq: 4, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ])
      })
    vi.stubGlobal("fetch", fetchMock)

    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    await collect(proxy.send("go"))
    await collect(proxy.send("again"))

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("throws (mirroring the fallback's exited handling) when the stream ends without a turn-end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "partial\n" },
        ]),
      ),
    )
    const output = vi.fn(async () => "box stderr tail")
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events: AgentStreamEvent[] = []
    await expect(async () => {
      for await (const ev of proxy.send("go")) events.push(ev)
    }).rejects.toThrow(/ended without a turn-end/)

    // The structured event still yielded before the connection dropped, plus
    // a best-effort harvest of the box's ring buffer.
    expect(events).toEqual([
      { kind: "text-delta", text: "partial\n" },
      { kind: "text-delta", text: "box stderr tail" },
    ])
  })

  it("falls back to the legacy agent_output poll when the stream route 404s (older box daemon)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([], 404)))

    const waitForAny = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: false, event: "turn-end" as const, sessionIds: [] })
    const output = vi.fn(async () => "flattened box output\n")
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      { kind: "text-delta", text: "flattened box output\n" },
      { kind: "turn-end", reason: "completed" },
    ])
    expect(waitForAny).toHaveBeenCalledTimes(1)
  })

  it("falls back to the legacy poll when the box is unreachable (connect error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )

    const waitForAny = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: false, event: "awaiting-input" as const, sessionIds: [] })
    const output = vi.fn(async () => "asking a question\n")
    const host = makeHost({ waitForAny, output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      { kind: "text-delta", text: "asking a question\n" },
      { kind: "turn-end", reason: "awaiting-input" },
    ])
  })
})
