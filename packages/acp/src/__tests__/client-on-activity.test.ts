import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK (same pattern as client-effort-graceful.test.ts) so we can
// drive onActivity without a real subprocess. Captures the handlers-factory
// passed to `new ClientSideConnection(factory, stream)` so tests can invoke
// `sessionUpdate` directly, as the SDK would on an incoming notification.
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

describe("createAcpClient — onActivity liveness callback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-activity" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" })
    mockCancel.mockResolvedValue({})
  })

  it("is never called just from construction — only real traffic pulses it", async () => {
    const onActivity = vi.fn()
    await createAcpClient({ ...fakeStreams(), onActivity })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it("fires after an outbound newSession resolves", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    expect(onActivity).not.toHaveBeenCalled()
    await client.newSession({ cwd: "/tmp" })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it("fires after an outbound loadSession resolves", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    await client.loadSession({ sessionId: "sess-activity", cwd: "/tmp" })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it("does not throw when onActivity is omitted", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    await expect(client.newSession({ cwd: "/tmp" })).resolves.toBeDefined()
  })

  it("fires on an incoming session/update notification that DOES translate to a StreamEvent", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    await client.newSession({ cwd: "/tmp" })
    onActivity.mockClear()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-activity",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it("fires on an incoming session/update notification that translates to null (the gap this feature closes)", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    await client.newSession({ cwd: "/tmp" })
    onActivity.mockClear()

    const handlers = capturedHandlersFactory!()
    // "user_message_chunk" is an update kind translateSessionUpdate maps to
    // null — today this produces no ring-buffer line at all. onActivity
    // must still fire so lastActivityAt doesn't go stale during a long
    // internal tool-call chain that only emits these.
    await handlers.sessionUpdate({
      sessionId: "sess-activity",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it("fires even for a notification whose sessionId has no registered session", async () => {
    const onActivity = vi.fn()
    await createAcpClient({ ...fakeStreams(), onActivity })
    // No newSession/loadSession call — no session registered at all.
    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "unregistered-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    })
    expect(onActivity).toHaveBeenCalledTimes(1)
  })

  it("fires on outbound prompt send and again on turn-end resolution", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    const session = await client.newSession({ cwd: "/tmp" })
    onActivity.mockClear()

    let resolvePrompt: (v: { stopReason: string }) => void
    mockPrompt.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePrompt = resolve
      }),
    )

    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    // The outbound send itself pulses onActivity synchronously, before the
    // SDK's prompt() promise ever resolves.
    expect(onActivity).toHaveBeenCalledTimes(1)

    resolvePrompt!({ stopReason: "end_turn" })
    const { value } = await iter.next()
    expect(value?.kind).toBe("turn-end")
    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it("fires on cancel()", async () => {
    const onActivity = vi.fn()
    const client = await createAcpClient({ ...fakeStreams(), onActivity })
    const session = await client.newSession({ cwd: "/tmp" })
    onActivity.mockClear()

    mockPrompt.mockReturnValueOnce(new Promise(() => {})) // never resolves
    session.prompt({ messages: [{ type: "text", text: "go" }] })
    onActivity.mockClear() // drop the outbound-send pulse from prompt()

    await session.cancel()
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(mockCancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-activity" }))
  })
})
