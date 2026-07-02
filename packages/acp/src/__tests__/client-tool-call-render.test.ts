import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Same mock pattern as client-on-activity.test.ts — captures the handlers
// factory passed to `new ClientSideConnection(factory, stream)` so tests can
// drive `sessionUpdate` directly, as the SDK would on an incoming
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

describe("createAcpClient — tool_call rendering fields", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-tool" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockPrompt.mockReturnValue(new Promise(() => {})) // never resolves — only inspecting tool-call events
    mockCancel.mockResolvedValue({})
  })

  it("prefers the descriptive `title` over the coarse `kind` for toolName", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        kind: "read",
        title: "Reading src/foo.ts",
        rawInput: { file_path: "src/foo.ts" },
      },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "tool-call",
      toolName: "Reading src/foo.ts",
      arguments: { file_path: "src/foo.ts" },
    })
  })

  it("falls back to `kind` when `title` is absent", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: { sessionUpdate: "tool_call", toolCallId: "call-2", kind: "search" },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({ kind: "tool-call", toolName: "search" })
  })

  it("falls back to \"tool\" when neither `title` nor `kind` is present", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: { sessionUpdate: "tool_call", toolCallId: "call-3" },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({ kind: "tool-call", toolName: "tool" })
  })

  it("folds a single `locations` entry into `arguments` when `rawInput` is absent", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-4",
        title: "Reading src/bar.ts",
        locations: [{ path: "src/bar.ts", line: 12 }],
      },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "tool-call",
      toolName: "Reading src/bar.ts",
      arguments: { path: "src/bar.ts", line: 12 },
    })
  })

  it("folds multiple `locations` entries into a `paths` array", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-5",
        title: "Searching",
        locations: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "tool-call",
      toolName: "Searching",
      arguments: { paths: ["a.ts", "b.ts"] },
    })
  })

  it("prefers `rawInput` over `locations` when both are present", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-6",
        title: "Editing",
        rawInput: { file_path: "explicit.ts" },
        locations: [{ path: "ignored.ts" }],
      },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "tool-call",
      toolName: "Editing",
      arguments: { file_path: "explicit.ts" },
    })
  })
})
