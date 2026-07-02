import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Same mock pattern as client-tool-call-render.test.ts — captures the
// handlers factory passed to `new ClientSideConnection(factory, stream)` so
// tests can drive `sessionUpdate` directly, as the SDK would on an incoming
// notification, and read the resulting StreamEvent off `session.prompt()`.
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

describe("createAcpClient — plan / usage_update translation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-plan" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockPrompt.mockReturnValue(new Promise(() => {})) // never resolves — only inspecting events
    mockCancel.mockResolvedValue({})
  })

  it("translates a plan update into a StreamEvent with normalized entries", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the file", priority: "high", status: "completed" },
          { content: "Write the fix", priority: "medium", status: "in_progress" },
        ],
      },
    })

    const { value } = await iter.next()
    expect(value).toEqual({
      kind: "plan",
      sessionId: "sess-plan",
      entries: [
        { content: "Read the file", priority: "high", status: "completed" },
        { content: "Write the fix", priority: "medium", status: "in_progress" },
      ],
    })
  })

  it("defaults a plan entry's priority/status when the upstream omits them", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: { sessionUpdate: "plan", entries: [{ content: "Do a thing" }] },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "plan",
      entries: [{ content: "Do a thing", priority: "medium", status: "pending" }],
    })
  })

  it("translates a usage_update into a StreamEvent with size/used/cost", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: {
        sessionUpdate: "usage_update",
        size: 200_000,
        used: 15_000,
        cost: { amount: 0.34, currency: "USD" },
      },
    })

    const { value } = await iter.next()
    expect(value).toEqual({
      kind: "usage_update",
      sessionId: "sess-plan",
      size: 200_000,
      used: 15_000,
      cost: { amount: 0.34, currency: "USD" },
    })
  })

  it("omits cost from a usage_update StreamEvent when the upstream doesn't report one", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: { sessionUpdate: "usage_update", size: 100_000, used: 500 },
    })

    const { value } = await iter.next()
    expect(value).toEqual({
      kind: "usage_update",
      sessionId: "sess-plan",
      size: 100_000,
      used: 500,
    })
  })

  it("still drops unknown session-update kinds (e.g. available_commands_update)", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    })
    // Follow with a real event so the iterator has something to yield —
    // otherwise this test can't distinguish "dropped" from "not delivered yet".
    await handlers.sessionUpdate({
      sessionId: "sess-plan",
      update: { sessionUpdate: "usage_update", size: 1, used: 1 },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({ kind: "usage_update" })
  })
})
