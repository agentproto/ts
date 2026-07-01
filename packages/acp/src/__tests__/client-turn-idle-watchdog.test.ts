import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Same mocking pattern as client-on-activity.test.ts: mock the ACP SDK so we
// can drive `session/update` notifications and control when (or whether)
// `connection.prompt()` resolves, without a real subprocess.
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockNewSession = vi.fn()
const mockLoadSession = vi.fn()
const mockSetSessionConfigOption = vi.fn()
const mockPrompt = vi.fn()
const mockCancel = vi.fn()

let capturedHandlersFactory: (() => { sessionUpdate: (params: unknown) => Promise<void> }) | undefined

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation((handlersFactory: typeof capturedHandlersFactory) => {
    capturedHandlersFactory = handlersFactory
    return {
      initialize: mockInitialize,
      newSession: mockNewSession,
      loadSession: mockLoadSession,
      setSessionConfigOption: mockSetSessionConfigOption,
      prompt: mockPrompt,
      cancel: mockCancel,
      on: vi.fn(),
      off: vi.fn(),
    }
  }),
}))

import { createAcpClient } from "../client/index.js"

function fakeStreams() {
  return { output: new WritableStream(), input: new ReadableStream() }
}

describe("createAcpClient — turn-idle watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-watchdog" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockCancel.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("never fires when turnIdleTimeoutMs is omitted, even if prompt() never resolves", async () => {
    mockPrompt.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    let settled = false
    void iter.next().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(10_000_000)
    expect(settled).toBe(false)
  })

  it("synthesizes a turn-end with reason watchdog-timeout after the configured silence", async () => {
    mockPrompt.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const client = await createAcpClient({ ...fakeStreams(), turnIdleTimeoutMs: 60_000 })
    const session = await client.newSession({ cwd: "/tmp" })

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const next = iter.next()
    await vi.advanceTimersByTimeAsync(60_000)
    const { value, done } = await next

    expect(done).toBe(false)
    expect(value).toEqual({ kind: "turn-end", sessionId: "sess-watchdog", reason: "watchdog-timeout" })

    // The iterator completes right after — no further events queued.
    const { done: done2 } = await iter.next()
    expect(done2).toBe(true)
  })

  it("does NOT fire when activity pulses arrive at intervals shorter than the timeout, even though total turn duration exceeds it", async () => {
    mockPrompt.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const client = await createAcpClient({ ...fakeStreams(), turnIdleTimeoutMs: 1_000 })
    const session = await client.newSession({ cwd: "/tmp" })
    const handlers = capturedHandlersFactory!()

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const next = iter.next()
    let settled = false
    void next.then(() => {
      settled = true
    })

    // Pulse activity every 600ms — gaps never exceed the 1000ms timeout —
    // for a total elapsed time (3000ms) that's 3x the timeout.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(600)
      await handlers.sessionUpdate({
        sessionId: "sess-watchdog",
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
      })
      expect(settled).toBe(false)
    }

    // No turn-end should have been synthesized despite 3000ms of total
    // elapsed turn duration — every individual gap stayed under the
    // 1000ms timeout, so the watchdog was reset each time before firing.
    expect(settled).toBe(false)
  })

  it("logs and discards a late prompt() resolution after the watchdog already fired (no crash, no duplicate turn-end)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let resolvePrompt: (v: { stopReason: string }) => void
    mockPrompt.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePrompt = resolve
      }),
    )
    const client = await createAcpClient({ ...fakeStreams(), turnIdleTimeoutMs: 60_000 })
    const session = await client.newSession({ cwd: "/tmp" })

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const first = iter.next()
    await vi.advanceTimersByTimeAsync(60_000)
    const { value } = await first
    expect(value).toEqual({ kind: "turn-end", sessionId: "sess-watchdog", reason: "watchdog-timeout" })

    // The underlying connection.prompt() finally resolves, long after the
    // synthetic turn-end was already emitted.
    resolvePrompt!({ stopReason: "end_turn" })
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/turn-idle watchdog already synthesized/),
    )

    warnSpy.mockRestore()
  })

  it("resets the timer on an incoming session/update so a slow-but-active turn eventually still completes via the real response, not the watchdog", async () => {
    let resolvePrompt: (v: { stopReason: string }) => void
    mockPrompt.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePrompt = resolve
      }),
    )
    const client = await createAcpClient({ ...fakeStreams(), turnIdleTimeoutMs: 1_000 })
    const session = await client.newSession({ cwd: "/tmp" })
    const handlers = capturedHandlersFactory!()

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const next = iter.next()

    await vi.advanceTimersByTimeAsync(700)
    await handlers.sessionUpdate({
      sessionId: "sess-watchdog",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
    })
    await vi.advanceTimersByTimeAsync(700)

    resolvePrompt!({ stopReason: "end_turn" })
    const { value } = await next
    expect(value).toEqual({ kind: "turn-end", sessionId: "sess-watchdog", reason: "completed" })
  })
})
