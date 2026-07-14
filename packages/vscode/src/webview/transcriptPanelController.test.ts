import { describe, expect, it, vi } from "vitest"

import { TranscriptPanelController } from "./transcriptPanelController.js"
import { NoTranscriptError } from "../client/daemonClient.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type {
  SessionDescriptor,
  SessionEventRecord,
  SessionEventsPage,
  SessionStreamLine,
} from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import type { ExtMessage } from "./protocol.js"
import type { PresentedConversation } from "./conversation.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function page(events: SessionEventRecord[], over: Partial<SessionEventsPage> = {}): SessionEventsPage {
  const nextSeq = events.length ? events[events.length - 1]!.seq : 0
  return { sessionId: "s1", events, nextSeq, complete: true, ...over }
}

let seq = 0
function ev(over: Partial<SessionEventRecord> & { kind: string }): SessionEventRecord {
  return { seq: ++seq, ts: "2026-01-01T00:00:00Z", ...over }
}

function createMockMessenger(): {
  postMessage: ReturnType<typeof vi.fn>
  messages: ExtMessage[]
} {
  const messages: ExtMessage[] = []
  const postMessage = vi.fn((msg: ExtMessage) => {
    messages.push(msg)
    return Promise.resolve(undefined)
  })
  return { postMessage, messages }
}

type MockClient = DaemonClient & {
  prompt: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  exportSession: ReturnType<typeof vi.fn>
  preview: ReturnType<typeof vi.fn>
  getSession: ReturnType<typeof vi.fn>
  getSessionEvents: ReturnType<typeof vi.fn>
}

function createMockClient(over: Partial<Record<keyof MockClient, unknown>> = {}): MockClient {
  return {
    url: "http://127.0.0.1:18790",
    prompt: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue({ content: "# hello", format: "markdown" }),
    preview: vi.fn().mockResolvedValue({ id: "s1", lines: ["line"], bytes: null }),
    getSession: vi.fn().mockResolvedValue(session()),
    getSessionEvents: vi.fn().mockResolvedValue(page([])),
    ...over,
  } as unknown as MockClient
}

function createMockStore(): SessionStore & { emitLine: (line: SessionStreamLine) => void } {
  let lineHandler: ((line: SessionStreamLine) => void) | undefined
  return {
    focusOutput: vi.fn((_id, handlers) => {
      lineHandler = handlers.onLine
      return { dispose: vi.fn() }
    }),
    emitLine(line: SessionStreamLine) {
      lineHandler?.(line)
    },
  } as unknown as SessionStore & { emitLine: (line: SessionStreamLine) => void }
}

function make(
  client: MockClient,
  opts: Partial<{ initialSession: SessionDescriptor; autoPoll: boolean }> = {},
): { controller: TranscriptPanelController; messenger: ReturnType<typeof createMockMessenger>; store: ReturnType<typeof createMockStore> } {
  const messenger = createMockMessenger()
  const store = createMockStore()
  const controller = new TranscriptPanelController({
    sessionId: "s1",
    initialSession: opts.initialSession ?? session(),
    client,
    store,
    messenger,
    autoPoll: opts.autoPoll ?? false,
  })
  return { controller, messenger, store }
}

function initMsg(messages: ExtMessage[]): Extract<ExtMessage, { type: "init" }> {
  const m = messages.find(x => x.type === "init")
  if (!m || m.type !== "init") throw new Error("no init message")
  return m
}

function textOf(conv: PresentedConversation): string[] {
  return conv.turns.flatMap(t => t.segments.filter(s => s.kind === "assistant-text" || s.kind === "user").map(s => (s as { html: string }).html))
}

describe("TranscriptPanelController — raw fallback mode", () => {
  it("uses raw mode for terminal sessions and streams lines", async () => {
    const client = createMockClient()
    const { controller, messenger, store } = make(client, {
      initialSession: session({ kind: "terminal" }),
    })

    store.emitLine({ line: "before-ready" })
    expect(messenger.messages).toHaveLength(0)

    await controller.onReady()
    // Terminal sessions never query structured events.
    expect(client.getSessionEvents).not.toHaveBeenCalled()
    const init = initMsg(messenger.messages)
    expect(init.mode).toBe("raw")
    expect(messenger.messages).toContainEqual({ type: "lines", lines: [{ line: "before-ready" }] })
  })

  it("degrades to raw when the events route is unavailable (non-NoTranscript error)", async () => {
    const client = createMockClient({
      getSessionEvents: vi.fn().mockRejectedValue(new Error("HTTP 404 not_found")),
    })
    const { controller, messenger } = make(client)

    await controller.onReady()
    const init = initMsg(messenger.messages)
    expect(init.mode).toBe("raw")
    expect(client.exportSession).toHaveBeenCalledWith("s1", "markdown")
  })

  it("stays structured (empty) when the session has no events yet", async () => {
    const client = createMockClient({
      getSessionEvents: vi.fn().mockRejectedValue(new NoTranscriptError("s1")),
    })
    const { controller, messenger } = make(client)

    await controller.onReady()
    const init = initMsg(messenger.messages)
    expect(init.mode).toBe("structured")
    expect(init.conversation?.turns).toEqual([])
    // A structured session must NOT fall back to the raw export.
    expect(client.exportSession).not.toHaveBeenCalled()
  })

  it("preserves the latest pre-ready descriptor and forwards it if it differs", async () => {
    const initial = session({ kind: "terminal", costUsd: 0 })
    const updated = session({ kind: "terminal", costUsd: 0.01 })
    const client = createMockClient({ getSession: vi.fn().mockResolvedValue(initial) })
    const { controller, messenger } = make(client, { initialSession: initial })

    controller.onSessionUpdate(updated)
    await controller.onReady()

    expect(initMsg(messenger.messages)).toMatchObject({ type: "init", session: initial })
    expect(messenger.messages).toContainEqual({ type: "sessionUpdate", session: updated })
  })
})

describe("TranscriptPanelController — structured hydration & live poll", () => {
  it("hydrates events into a chat timeline on init", async () => {
    seq = 0
    const client = createMockClient({
      getSessionEvents: vi.fn().mockResolvedValue(
        page([
          ev({ kind: "user-prompt", text: "hello" }),
          ev({ kind: "text-delta", text: "Hi there\n" }),
          ev({ kind: "turn-end", reason: "completed" }),
        ]),
      ),
    })
    const { controller, messenger } = make(client)

    await controller.onReady()
    const init = initMsg(messenger.messages)
    expect(init.mode).toBe("structured")
    const conv = init.conversation!
    expect(conv.turns.map(t => t.role)).toEqual(["user", "assistant"])
    const htmls = textOf(conv)
    expect(htmls).toHaveLength(2)
    expect(htmls[0]).toContain("hello")
    expect(htmls[1]).toContain("Hi there")
    // The raw stream is never used in structured mode.
    expect(client.exportSession).not.toHaveBeenCalled()
  })

  it("paginates hydration when a page is capped (complete=false)", async () => {
    seq = 0
    const first = page([ev({ kind: "user-prompt", text: "a" })], { nextSeq: 1, complete: false })
    const second = page([ev({ kind: "text-delta", text: "b\n" })], { nextSeq: 2, complete: true })
    const getSessionEvents = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const client = createMockClient({ getSessionEvents })
    const { controller, messenger } = make(client)

    await controller.onReady()
    expect(getSessionEvents).toHaveBeenNthCalledWith(1, "s1", { since: 0 })
    expect(getSessionEvents).toHaveBeenNthCalledWith(2, "s1", { since: 1 })
    const conv = initMsg(messenger.messages).conversation!
    expect(conv.turns).toHaveLength(2) // user + assistant
  })

  it("live-polls from the advancing cursor and posts a conversation update", async () => {
    seq = 0
    const hydrate = page([ev({ kind: "user-prompt", text: "hello" })], { nextSeq: 1, complete: true })
    const poll = page(
      [ev({ kind: "text-delta", text: "world\n" }), ev({ kind: "turn-end", reason: "completed" })],
      { nextSeq: 3, complete: true },
    )
    const getSessionEvents = vi.fn().mockResolvedValueOnce(hydrate).mockResolvedValueOnce(poll)
    const client = createMockClient({ getSessionEvents })
    const { controller, messenger } = make(client)

    await controller.onReady()
    await controller.pollOnce()

    // Second call resumes from the hydration cursor.
    expect(getSessionEvents).toHaveBeenNthCalledWith(2, "s1", { since: 1 })
    const update = messenger.messages.find(m => m.type === "conversation")
    expect(update).toBeDefined()
    const conv = (update as Extract<ExtMessage, { type: "conversation" }>).conversation
    expect(conv.turns.some(t => t.role === "assistant")).toBe(true)
  })

  it("preserves thought→text→tool ordering across hydration + poll", async () => {
    seq = 0
    const hydrate = page(
      [ev({ kind: "user-prompt", text: "go" }), ev({ kind: "thought", text: "thinking\n" })],
      { nextSeq: 2, complete: true },
    )
    const poll = page(
      [
        ev({ kind: "text-delta", text: "running\n" }),
        ev({ kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: { c: "ls" } }),
        ev({ kind: "tool-result", toolCallId: "t1", result: "ok", isError: false }),
      ],
      { nextSeq: 5, complete: true },
    )
    const getSessionEvents = vi.fn().mockResolvedValueOnce(hydrate).mockResolvedValueOnce(poll)
    const { controller, messenger } = make(createMockClient({ getSessionEvents }))

    await controller.onReady()
    await controller.pollOnce()

    const update = messenger.messages.filter(m => m.type === "conversation").pop()
    const conv = (update as Extract<ExtMessage, { type: "conversation" }>).conversation
    const assistant = conv.turns.find(t => t.role === "assistant")!
    expect(assistant.segments.map(s => s.kind)).toEqual([
      "reasoning",
      "assistant-text",
      "tool",
    ])
  })

  it("reconnect: a transient poll failure is swallowed and resumes on the same cursor with no duplicate segments", async () => {
    seq = 0
    const hydrate = page([ev({ kind: "user-prompt", text: "hi" }), ev({ kind: "text-delta", text: "Hel" })], {
      nextSeq: 2,
      complete: true,
    })
    const tail = page([ev({ kind: "text-delta", text: "lo\n" })], { nextSeq: 3, complete: true })
    const getSessionEvents = vi.fn()
      .mockResolvedValueOnce(hydrate)
      .mockRejectedValueOnce(new Error("daemon restarting")) // dropped poll
      .mockResolvedValueOnce(tail)
    const { controller, messenger } = make(createMockClient({ getSessionEvents }))

    await controller.onReady()
    await controller.pollOnce() // fails — no update, cursor unchanged
    expect(messenger.messages.some(m => m.type === "conversation")).toBe(false)
    await controller.pollOnce() // resumes from since=2

    // All three post-hydration polls used the SAME cursor (2), never regressing.
    expect(getSessionEvents.mock.calls.slice(1)).toEqual([
      ["s1", { since: 2 }],
      ["s1", { since: 2 }],
    ])
    const update = messenger.messages.filter(m => m.type === "conversation").pop()
    const conv = (update as Extract<ExtMessage, { type: "conversation" }>).conversation
    const assistant = conv.turns.find(t => t.role === "assistant")!
    // "Hel" + "lo\n" merged into ONE assistant-text segment — not duplicated.
    const texts = assistant.segments.filter(s => s.kind === "assistant-text")
    expect(texts).toHaveLength(1)
  })

  it("does not double-apply overlapping records (dedupe by seq)", async () => {
    seq = 0
    const first = ev({ kind: "user-prompt", text: "hi" })
    const second = ev({ kind: "text-delta", text: "yo\n" })
    const hydrate = page([first, second], { nextSeq: 2, complete: true })
    // A poll that (wrongly) re-delivers seq 2 alongside a new seq 3.
    const overlap = page([second, ev({ kind: "turn-end", reason: "completed" })], {
      nextSeq: 3,
      complete: true,
    })
    const getSessionEvents = vi.fn().mockResolvedValueOnce(hydrate).mockResolvedValueOnce(overlap)
    const { controller, messenger } = make(createMockClient({ getSessionEvents }))

    await controller.onReady()
    await controller.pollOnce()

    const update = messenger.messages.filter(m => m.type === "conversation").pop()
    const conv = (update as Extract<ExtMessage, { type: "conversation" }>).conversation
    const assistant = conv.turns.find(t => t.role === "assistant")!
    const texts = assistant.segments.filter(s => s.kind === "assistant-text")
    expect(texts).toHaveLength(1)
    expect((texts[0] as { html: string }).html).toContain("yo")
  })

  it("pollOnce is a no-op after dispose", async () => {
    seq = 0
    const getSessionEvents = vi.fn().mockResolvedValue(page([]))
    const { controller } = make(createMockClient({ getSessionEvents }))
    await controller.onReady()
    const callsAfterInit = getSessionEvents.mock.calls.length
    controller.dispose()
    await controller.pollOnce()
    expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit)
  })
})

describe("TranscriptPanelController — ready & send safety", () => {
  it("is safe to call onReady multiple times", async () => {
    const { controller, messenger } = make(createMockClient())
    await controller.onReady()
    await controller.onReady()
    expect(messenger.messages.filter(m => m.type === "init")).toHaveLength(1)
  })

  it("initializes exactly once when concurrent onReady calls race before hydration", async () => {
    let resolveEvents: (v: SessionEventsPage) => void = () => {}
    let resolveGet: (v: SessionDescriptor) => void = () => {}
    const client = createMockClient({
      getSessionEvents: vi.fn(() => new Promise(r => { resolveEvents = r })),
      getSession: vi.fn(() => new Promise(r => { resolveGet = r })),
    })
    const { controller, messenger, store } = make(client)

    store.emitLine({ line: "buffered" }) // structured mode will drop this

    const ready1 = controller.onReady()
    const ready2 = controller.onReady()
    expect(client.getSessionEvents).toHaveBeenCalledTimes(1)
    expect(client.getSession).toHaveBeenCalledTimes(1)

    resolveEvents(page([]))
    resolveGet(session())
    await Promise.all([ready1, ready2])

    expect(messenger.messages.filter(m => m.type === "init")).toHaveLength(1)
  })

  it("sends fire-and-forget prompts with sending → ack ordering", async () => {
    const client = createMockClient()
    const { controller, messenger } = make(client)
    await controller.onSend("hello", false)
    expect(client.prompt).toHaveBeenCalledWith("s1", "hello", { interrupt: false, wait: false })
    expect(messenger.messages.map(m => m.type)).toEqual(["sending", "sendAck"])
  })

  it("sends sending → error when prompt fails", async () => {
    const client = createMockClient({ prompt: vi.fn().mockRejectedValue(new Error("boom")) })
    const { controller, messenger } = make(client)
    await controller.onSend("hello", true)
    expect(client.prompt).toHaveBeenCalledWith("s1", "hello", { interrupt: true, wait: false })
    expect(messenger.messages[0]).toMatchObject({ type: "sending" })
    expect(messenger.messages[1]).toMatchObject({ type: "sendError", message: "boom" })
  })

  it("suppresses concurrent sends until the admission promise settles", async () => {
    let resolvePrompt: (() => void) | undefined
    const promptPromise = new Promise<void>(r => { resolvePrompt = r })
    const client = createMockClient({ prompt: vi.fn(() => promptPromise) })
    const { controller, messenger } = make(client)

    const send1 = controller.onSend("first", false)
    const send2 = controller.onSend("second", false)
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(client.prompt).toHaveBeenLastCalledWith("s1", "first", { interrupt: false, wait: false })
    expect(messenger.messages.filter(m => m.type === "sending")).toHaveLength(1)

    resolvePrompt!()
    await send1
    await send2
    expect(messenger.messages.map(m => m.type)).toEqual(["sending", "sendAck"])

    await controller.onSend("third", true)
    expect(client.prompt).toHaveBeenCalledTimes(2)
    expect(client.prompt).toHaveBeenLastCalledWith("s1", "third", { interrupt: true, wait: false })
  })
})
