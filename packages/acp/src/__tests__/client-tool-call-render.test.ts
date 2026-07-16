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

/**
 * Frames below are copied VERBATIM from a wire trace of the real claude-code
 * ACP bridge (`@agentclientprotocol/claude-agent-acp`) reading a file. The
 * bridge announces a call it does not yet know the input of, then fills it in
 * — and the fill-in frame carries no `status`, which is what used to make
 * `translateSessionUpdate` drop it and render "Read File" with an empty input
 * for ~95% of that adapter's tool calls.
 */
describe("createAcpClient — tool_call_update carries the input (claude-code bridge)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-tool" })
    mockLoadSession.mockResolvedValue({})
    mockSetSessionConfigOption.mockResolvedValue({})
    mockPrompt.mockReturnValue(new Promise(() => {}))
    mockCancel.mockResolvedValue({})
  })

  it("emits the input and the real title from the in-progress update", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const handlers = capturedHandlersFactory!()

    // Frame 1 — the announcement. rawInput is an EMPTY object, not the input.
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_01Buvi",
        kind: "read",
        title: "Read File",
        rawInput: {},
        locations: [],
        content: [],
      },
    })
    expect((await iter.next()).value).toMatchObject({
      kind: "tool-call",
      toolCallId: "toolu_01Buvi",
      toolName: "Read File",
    })

    // Frame 2 — no status. This is the one that used to be discarded.
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_01Buvi",
        title: "Read /private/tmp/acp-probe/probe.txt",
        rawInput: { file_path: "/private/tmp/acp-probe/probe.txt" },
        locations: [{ line: 1, path: "/private/tmp/acp-probe/probe.txt" }],
      },
    })
    expect((await iter.next()).value).toMatchObject({
      kind: "tool-call",
      toolCallId: "toolu_01Buvi",
      toolName: "Read /private/tmp/acp-probe/probe.txt",
      arguments: { file_path: "/private/tmp/acp-probe/probe.txt" },
      // Flagged so consumers merge onto the announced call instead of
      // rendering a second card for one read.
      isUpdate: true,
    })
  })

  it("stays silent on an update that adds nothing", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const handlers = capturedHandlersFactory!()

    // Frame 3 from the same trace: a bare keep-alive. No title, no input —
    // a no-op frame must stay a no-op event, not an empty tool-call.
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: { sessionUpdate: "tool_call_update", toolCallId: "toolu_01Buvi" },
    })
    // Frame 4 — completion still yields the result, exactly as before.
    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_01Buvi",
        status: "completed",
        rawOutput: { content: "hello from the probe" },
      },
    })

    const { value } = await iter.next()
    expect(value).toMatchObject({
      kind: "tool-result",
      toolCallId: "toolu_01Buvi",
      result: { content: "hello from the probe" },
    })
  })

  it("still reports a failed update as an errored result", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session.prompt({ messages: [{ type: "text", text: "go" }] })[Symbol.asyncIterator]()
    const handlers = capturedHandlersFactory!()

    await handlers.sessionUpdate({
      sessionId: "sess-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-x",
        status: "failed",
        rawOutput: "boom",
      },
    })

    expect((await iter.next()).value).toMatchObject({
      kind: "tool-result",
      isError: true,
      result: "boom",
    })
  })
})
