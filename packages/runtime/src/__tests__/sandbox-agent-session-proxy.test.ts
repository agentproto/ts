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
    vi.useRealTimers()
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

  it("re-opens the stream from the last consumed seq when it drops mid-turn instead of failing a live turn", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (input: string | URL) => {
        expect(new URL(input).searchParams.get("since")).toBe("0")
        // The connection dies after the tool call, while the box session is
        // still running (no turn-end): exactly the 2026-10-23 incident.
        return sseResponse([
          {
            seq: 1,
            ts: "t",
            kind: "tool-call",
            sessionId: "remote_1",
            toolCallId: "tc1",
            toolName: "bash",
            arguments: { command: "pnpm install" },
          },
        ])
      })
      .mockImplementationOnce(async (input: string | URL) => {
        expect(new URL(input).searchParams.get("since")).toBe("1")
        return sseResponse([
          { seq: 2, ts: "t", kind: "tool-result", sessionId: "remote_1", toolCallId: "tc1", isError: false },
          { seq: 3, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ])
      })
    vi.stubGlobal("fetch", fetchMock)

    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const done = collect(proxy.send("go"))
    await vi.advanceTimersByTimeAsync(10_000)
    const events = await done

    expect(events.map(e => e.kind)).toEqual(["tool-call", "tool-result", "turn-end"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up (mirroring the fallback's exited handling) only after the dropped stream fails to recover", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "partial\n" },
        ]),
      )
      // Every reconnect gets a stream that ends again with no record at all.
      .mockImplementation(async () => sseResponse([]))
    vi.stubGlobal("fetch", fetchMock)
    const output = vi.fn(async () => "box stderr tail")
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events: AgentStreamEvent[] = []
    const done = (async () => {
      for await (const ev of proxy.send("go")) events.push(ev)
    })().catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(120_000)
    const err = await done

    expect(String(err)).toMatch(/ended without a turn-end/)
    expect(String(err)).toMatch(/consecutive reconnect failures/)
    // The structured event still yielded before the connection dropped, plus
    // a best-effort harvest of the box's ring buffer.
    expect(events).toEqual([
      { kind: "text-delta", text: "partial\n" },
      { kind: "text-delta", text: "box stderr tail" },
    ])
  })

  it("close() during a reconnect wait ends the turn promptly without a daemon-lost error", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementationOnce(async () =>
      sseResponse([
        {
          seq: 1,
          ts: "t",
          kind: "tool-call",
          sessionId: "remote_1",
          toolCallId: "tc1",
          toolName: "bash",
          arguments: { command: "pnpm install" },
        },
      ]),
    )
    vi.stubGlobal("fetch", fetchMock)
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events: AgentStreamEvent[] = []
    const done = (async () => {
      for await (const ev of proxy.send("go")) events.push(ev)
    })().then(
      () => undefined,
      (err: unknown) => err,
    )

    // The first connection delivers its record and drops into the 5s wait.
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const closed = proxy.close()
    // No 5s advance: the abort must settle the wait immediately.
    await vi.advanceTimersByTimeAsync(0)
    const err = await done
    await closed

    expect(err).toBeUndefined()
    expect(events).toEqual([
      { kind: "tool-call", toolCallId: "tc1", toolName: "bash", arguments: { command: "pnpm install" } },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps turning when a productive tunnel drops repeatedly (40 drops, each after real records)", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    for (let i = 0; i < 40; i++) {
      fetchMock.mockImplementationOnce(async () =>
        sseResponse([
          { seq: i + 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: `chunk ${i + 1}\n` },
        ]),
      )
    }
    fetchMock.mockImplementationOnce(async () =>
      sseResponse([{ seq: 41, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" }]),
    )
    vi.stubGlobal("fetch", fetchMock)
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const done = collect(proxy.send("go"))
    await vi.advanceTimersByTimeAsync(40 * 5_000 + 10_000)
    const events = await done

    expect(events.filter(e => e.kind === "text-delta")).toHaveLength(40)
    expect(events[events.length - 1]).toEqual({ kind: "turn-end", reason: "completed" })
    expect(fetchMock).toHaveBeenCalledTimes(41)
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

describe("sandbox proxy — device first-turn failure surfacing (surfaceHostTurnErrors)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const WARNING_LINE =
    "\x1b[33m[warning] empty turn — no assistant output, no tool call. " +
    "Likely an invalid model id or a provider that returned nothing.\x1b[0m"

  it("surfaces the box's raw error line as a notice before an EMPTY first turn-end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "user-prompt", sessionId: "remote_1", text: "go" },
          { seq: 2, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ]),
      ),
    )
    // Ring buffer has the prompt echo + the warning; only the warning surfaces.
    const output = vi.fn(async () => `── ▶ go ──\n${WARNING_LINE}\n── turn-end (completed) ──`)
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      surfaceHostTurnErrors: true,
    })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      {
        kind: "notice",
        text:
          "[warning] empty turn — no assistant output, no tool call. " +
          "Likely an invalid model id or a provider that returned nothing.",
      },
      { kind: "turn-end", reason: "completed" },
    ])
    expect(output).toHaveBeenCalledTimes(1)
  })

  it("surfaces the box's error line when the first turn ends with reason 'error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "error" },
        ]),
      ),
    )
    const output = vi.fn(async () => "[error] model not found: prism-ml/ternary-bonsai-2-27b")
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      surfaceHostTurnErrors: true,
    })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      { kind: "notice", text: "[error] model not found: prism-ml/ternary-bonsai-2-27b" },
      { kind: "turn-end", reason: "error" },
    ])
  })

  it("does NOT surface anything for a non-device session (flag omitted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([{ seq: 1, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" }]),
      ),
    )
    const output = vi.fn(async () => WARNING_LINE)
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([{ kind: "turn-end", reason: "completed" }])
    expect(output).not.toHaveBeenCalled()
  })

  it("does NOT surface anything when the first turn was productive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "hello\n" },
          { seq: 2, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ]),
      ),
    )
    const output = vi.fn(async () => WARNING_LINE)
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      surfaceHostTurnErrors: true,
    })

    const events = await collect(proxy.send("go"))

    expect(events).toEqual([
      { kind: "text-delta", text: "hello\n" },
      { kind: "turn-end", reason: "completed" },
    ])
    expect(output).not.toHaveBeenCalled()
  })

  it("only surfaces on the FIRST turn, not a later empty turn", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        sseResponse([
          { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "hello\n" },
          { seq: 2, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ]),
      )
      .mockImplementationOnce(async () =>
        sseResponse([{ seq: 3, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" }]),
      )
    vi.stubGlobal("fetch", fetchMock)

    const output = vi.fn(async () => WARNING_LINE)
    const host = makeHost({ output })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      surfaceHostTurnErrors: true,
    })

    await collect(proxy.send("go"))
    const second = await collect(proxy.send("again"))

    expect(second).toEqual([{ kind: "turn-end", reason: "completed" }])
    expect(output).not.toHaveBeenCalled()
  })
})

describe("sandbox proxy — onBeforeTeardown", () => {
  it("runs after the box's session is killed and before the box is stopped", async () => {
    const order: string[] = []
    const host = makeHost({
      kill: vi.fn(async () => {
        order.push("kill")
      }),
      stop: vi.fn(async () => {
        order.push("stop")
      }),
    })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      onBeforeTeardown: async () => {
        order.push("deliver")
      },
    })

    await proxy.close()

    expect(order).toEqual(["kill", "deliver", "stop"])
  })

  it("a failing hook never blocks the box from stopping", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      onBeforeTeardown: async () => {
        throw new Error("delivery exploded")
      },
    })

    await expect(proxy.close()).resolves.toBeUndefined()
    expect(host.stop).toHaveBeenCalledTimes(1)
  })

  it("skips the hook on a daemon-shutdown close and still stops the box", async () => {
    const host = makeHost()
    const hook = vi.fn(async () => undefined)
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      onBeforeTeardown: hook,
    })

    await proxy.close({ daemonShutdown: true })

    expect(hook).not.toHaveBeenCalled()
    expect(host.kill).toHaveBeenCalledTimes(1)
    expect(host.stop).toHaveBeenCalledTimes(1)
  })
})

describe("sandbox proxy — interrupt without replay", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A fake remote (box) daemon whose mutating `/sessions/*` routes gate
   *  EVERY POST behind the per-boot bearer token (`http-server.ts`'s
   *  `checkSessionsToken`) — the gate that 401'd every raw-`fetch`
   *  interrupt. Its MCP endpoint (how `prompt` reaches it) is unaffected. */
  async function unauthenticatedInterruptGate(input: string | URL, init?: RequestInit) {
    const url = new URL(input)
    if (init?.method === "POST" && url.pathname.startsWith("/sessions/")) {
      expect(init.headers instanceof Headers ? (init.headers as Headers).get("authorization") : (init.headers as Record<string, unknown>)?.["Authorization"] ?? (init.headers as Record<string, unknown>)?.["authorization"])
        .toBeUndefined()
      return new Response(
        JSON.stringify({ error: "sessions_unauthorized" }),
        { status: 401 },
      )
    }
    return undefined
  }

  it("settles the cancelled stream and sends only the replacement prompt once", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let opened!: () => void
    const streamOpened = new Promise<void>(resolve => { opened = resolve })
    const host = makeHost({
      interrupt: vi.fn(async () => {
        streamController.enqueue(new TextEncoder().encode(
          'data: {"seq":1,"kind":"turn-end","reason":"cancelled"}\n\n',
        ))
        streamController.close()
        return { wasBusy: true }
      }),
    })
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const gated = await unauthenticatedInterruptGate(input, init)
      if (gated) return gated
      const url = new URL(input)
      if (fetchMock.mock.calls.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { streamController = controller; opened() },
        }))
      }
      expect(url.searchParams.get("since")).toBe("1")
      return sseResponse([
        { seq: 2, kind: "text-delta", text: "new answer" },
        { seq: 3, kind: "turn-end", reason: "completed" },
      ])
    })
    vi.stubGlobal("fetch", fetchMock)
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })
    const previous = collect(proxy.send("previous request"))
    await streamOpened
    await proxy.cancel()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await previous).toEqual([{ kind: "turn-end", reason: "cancelled" }])
    expect(await collect(proxy.send("replacement request"))).toEqual([
      { kind: "text-delta", text: "new answer" },
      { kind: "turn-end", reason: "completed" },
    ])
    // The interrupt rode `agent_interrupt` over the host's MCP client (the
    // same channel the prompt authenticates through) — never the token-gated
    // raw POST route, which this fake daemon would have 401'd.
    expect(host.interrupt).toHaveBeenCalledTimes(1)
    expect(host.interrupt).toHaveBeenCalledWith("remote_1")
    expect(host.prompt).toHaveBeenCalledTimes(2)
    expect(host.prompt).toHaveBeenNthCalledWith(1, "remote_1", "previous request")
    expect(host.prompt).toHaveBeenNthCalledWith(2, "remote_1", "replacement request")
    expect(host.kill).not.toHaveBeenCalled()
  })

  it("interrupts a reattached session even when this proxy has sent no prompt", async () => {
    const host = makeHost()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })))
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })
    await proxy.cancel()
    expect(host.interrupt).toHaveBeenCalledTimes(1)
    expect(host.interrupt).toHaveBeenCalledWith("remote_1")
    expect(host.prompt).not.toHaveBeenCalled()
  })

  it.each(["close", "detach"] as const)("does not interrupt after %s", async action => {
    const host = makeHost()
    vi.stubGlobal("fetch", vi.fn())
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1", detachable: true })
    if (action === "close") await proxy.close()
    else proxy.detach!()
    await proxy.cancel()
    expect(host.interrupt).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()
  })

  it("surfaces a failed remote interrupt without replaying the previous prompt", async () => {
    const host = makeHost({
      interrupt: vi.fn(async () => {
        throw new Error("Tool `agent_interrupt` returned error: no session")
      }),
    })
    vi.stubGlobal("fetch", vi.fn())
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_1" })
    await expect(proxy.cancel()).rejects.toThrow(/agent_interrupt` returned error: no session/)
    expect(host.prompt).not.toHaveBeenCalled()
  })
})
