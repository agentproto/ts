import { homedir } from "node:os"

import { describe, expect, it, vi } from "vitest"

// The @mention file source shells out to git — mock it so the controller test
// stays hermetic (mentionSource.test.ts covers the real IO against a temp repo).
vi.mock("./mentionSource.js", () => ({ listRepoFiles: vi.fn().mockResolvedValue([]) }))

import { TranscriptPanelController } from "./transcriptPanelController.js"
import { resolveAttachmentsCwd } from "./attachments.logic.js"
import { listRepoFiles } from "./mentionSource.js"
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
  uploadFile: ReturnType<typeof vi.fn>
  resolveToken: ReturnType<typeof vi.fn>
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
    uploadFile: vi.fn().mockResolvedValue({ path: "/home/.agentproto/.agentproto-attachments/paste.png", bytes: 3 }),
    // Rejected by default so SseRecordFeed (transcriptPanelController.ts)
    // falls back to PollingRecordFeed immediately in every test that
    // doesn't explicitly opt into exercising the SSE path — same fallback
    // codepath a real old-daemon 404 takes, just triggered earlier.
    resolveToken: vi.fn().mockRejectedValue(new Error("no SSE in this test")),
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
    // Lines reach the webview as HOST-rendered HTML, never raw daemon text —
    // the webview must never parse daemon content.
    expect(messenger.messages).toContainEqual({
      type: "lines",
      lines: [{ html: "before-ready", stream: "stdout" }],
    })
  })

  it("converts a line's ANSI to styled HTML on the host, escape codes and all", async () => {
    // The daemon authors /stream lines pre-coloured (projectEvent). They used
    // to reach the webview raw and render as literal escape-code garbage.
    const client = createMockClient()
    const { controller, messenger, store } = make(client, {
      initialSession: session({ kind: "terminal" }),
    })
    await controller.onReady()
    messenger.messages.length = 0

    store.emitLine({ line: "\x1b[36m[tool] Read src/foo.ts\x1b[0m", stream: "stdout" })

    const msg = messenger.messages.find(m => m.type === "lines")
    expect(msg).toBeDefined()
    const html = (msg as { lines: { html: string }[] }).lines[0]?.html ?? ""
    expect(html).toBe(
      '<span style="color:var(--vscode-terminal-ansiCyan)">[tool] Read src/foo.ts</span>',
    )
    expect(html).not.toContain("\x1b")
  })

  it("escapes HTML in a raw line before it ever reaches the webview", async () => {
    const client = createMockClient()
    const { controller, messenger, store } = make(client, {
      initialSession: session({ kind: "terminal" }),
    })
    await controller.onReady()
    messenger.messages.length = 0

    store.emitLine({ line: "<img src=x onerror=alert(1)>", stream: "stderr" })

    const msg = messenger.messages.find(m => m.type === "lines")
    const line = (msg as { lines: { html: string; stream: string }[] }).lines[0]
    expect(line?.html).toBe("&lt;img src=x onerror=alert(1)&gt;")
    expect(line?.stream).toBe("stderr")
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

  it("live-polls from the advancing cursor and posts a patch", async () => {
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
    const update = messenger.messages.find(m => m.type === "patch")
    expect(update).toBeDefined()
    const patch = update as Extract<ExtMessage, { type: "patch" }>
    // The assistant turn is brand new relative to the hydration snapshot —
    // it's the only turn in the patch, not the whole timeline.
    expect(patch.upsertTurns.map(t => t.role)).toEqual(["assistant"])
    expect(patch.removeTurnIds).toEqual([])
  })

  it("posts nothing when a poll advances the cursor but changes nothing visible (no-op tick)", async () => {
    seq = 0
    const hydrate = page(
      [ev({ kind: "user-prompt", text: "hi" }), ev({ kind: "text-delta", text: "hey\n" })],
      { nextSeq: 2, complete: true },
    )
    // turn-end carries a new seq (so appendRecords reports `added`) but never
    // touches a segment, so the presented timeline is byte-for-byte the same.
    const poll = page([ev({ kind: "turn-end", reason: "completed" })], { nextSeq: 3, complete: true })
    const getSessionEvents = vi.fn().mockResolvedValueOnce(hydrate).mockResolvedValueOnce(poll)
    const { controller, messenger } = make(createMockClient({ getSessionEvents }))

    await controller.onReady()
    const messagesAfterInit = messenger.messages.length
    await controller.pollOnce()

    expect(messenger.messages.length).toBe(messagesAfterInit)
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

    const update = messenger.messages.filter(m => m.type === "patch").pop()
    const patch = update as Extract<ExtMessage, { type: "patch" }>
    const assistant = patch.upsertTurns.find(t => t.role === "assistant")!
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
    expect(messenger.messages.some(m => m.type === "patch")).toBe(false)
    await controller.pollOnce() // resumes from since=2

    // All three post-hydration polls used the SAME cursor (2), never regressing.
    expect(getSessionEvents.mock.calls.slice(1)).toEqual([
      ["s1", { since: 2 }],
      ["s1", { since: 2 }],
    ])
    const update = messenger.messages.filter(m => m.type === "patch").pop()
    const patch = update as Extract<ExtMessage, { type: "patch" }>
    const assistant = patch.upsertTurns.find(t => t.role === "assistant")!
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
    const overlap = page([second, ev({ kind: "text-delta", text: "!!\n" })], {
      nextSeq: 3,
      complete: true,
    })
    const getSessionEvents = vi.fn().mockResolvedValueOnce(hydrate).mockResolvedValueOnce(overlap)
    const { controller, messenger } = make(createMockClient({ getSessionEvents }))

    await controller.onReady()
    await controller.pollOnce()

    const update = messenger.messages.filter(m => m.type === "patch").pop()
    const patch = update as Extract<ExtMessage, { type: "patch" }>
    const assistant = patch.upsertTurns.find(t => t.role === "assistant")!
    const texts = assistant.segments.filter(s => s.kind === "assistant-text")
    // "yo\n" was already folded in during hydration and re-arrives verbatim
    // in the poll — it must NOT be re-appended alongside the genuinely new "!!\n".
    expect(texts).toHaveLength(1)
    expect((texts[0] as { html: string }).html).toContain("yo")
    expect((texts[0] as { html: string }).html).toContain("!!")
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

  it("auto-polls on the default 250ms interval and stops after dispose", async () => {
    vi.useFakeTimers()
    try {
      seq = 0
      const getSessionEvents = vi.fn().mockResolvedValue(page([]))
      const messenger = createMockMessenger()
      const store = createMockStore()
      const client = createMockClient({ getSessionEvents })
      const controller = new TranscriptPanelController({
        sessionId: "s1",
        initialSession: session(),
        client,
        store,
        messenger,
        // autoPoll defaults to true, pollIntervalMs defaults to 250.
      })
      await controller.onReady()
      const callsAfterInit = getSessionEvents.mock.calls.length

      await vi.advanceTimersByTimeAsync(249)
      expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit)
      await vi.advanceTimersByTimeAsync(1)
      expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit + 1)

      controller.dispose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A controllable SSE response body: `push` enqueues a `data:` frame,
 *  `close` ends the stream. Backs the fake `fetchImpl` in the SSE tests
 *  below so a test can decide exactly when a "live" record arrives. */
function controllableSseBody(): {
  response: Response
  push: (record: Record<string, unknown>) => void
  close: () => void
} {
  const encoder = new TextEncoder()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller
    },
  })
  return {
    response: new Response(stream, { status: 200 }),
    push(record) {
      ctrl?.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`))
    },
    close() {
      ctrl?.close()
    },
  }
}

/** Flushes pending microtasks (promise chains) without advancing real time —
 *  used to let SseRecordFeed's resolveToken().then(subscribeSse(...)) chain
 *  settle before a test asserts on its effects. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe("TranscriptPanelController — SSE record feed", () => {
  it("delivers a live record via SSE and posts a patch, same as polling would", async () => {
    seq = 0
    const hydrate = page([ev({ kind: "user-prompt", text: "hello" })], { nextSeq: 1, complete: true })
    const getSessionEvents = vi.fn().mockResolvedValue(hydrate)
    const sse = controllableSseBody()
    const fetchStreamImpl: typeof fetch = async input => {
      const url = String(input)
      if (url.includes("/events/stream")) return sse.response
      throw new Error(`unexpected fetch: ${url}`)
    }
    const fetchImpl = vi.fn(fetchStreamImpl)
    const client = createMockClient({
      getSessionEvents,
      resolveToken: vi.fn().mockResolvedValue(undefined),
    })
    const messenger = createMockMessenger()
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
      fetchImpl,
    })

    await controller.onReady()
    expect(getSessionEvents).toHaveBeenCalledTimes(1)
    await flushMicrotasks()

    sse.push({ seq: 2, ts: "2026-01-01T00:00:00Z", kind: "text-delta", text: "world\n" })
    await flushMicrotasks()

    const patch = messenger.messages.filter(m => m.type === "patch").pop()
    expect(patch).toBeDefined()
    const upserts = (patch as Extract<ExtMessage, { type: "patch" }>).upsertTurns
    expect(upserts.map(t => t.role)).toEqual(["assistant"])

    // The live record arrived over SSE, not another hydration-style poll.
    expect(getSessionEvents).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/sessions/s1/events/stream?since=1`),
      expect.anything(),
    )
    controller.dispose()
  })

  it("falls back to polling when the stream route 404s (old daemon)", async () => {
    vi.useFakeTimers()
    try {
      seq = 0
      const getSessionEvents = vi.fn().mockResolvedValue(page([]))
      const fetchStreamImpl: typeof fetch = async () => new Response(null, { status: 404 })
      const fetchImpl = vi.fn(fetchStreamImpl)
      const client = createMockClient({
        getSessionEvents,
        resolveToken: vi.fn().mockResolvedValue(undefined),
      })
      const messenger = createMockMessenger()
      const store = createMockStore()
      const controller = new TranscriptPanelController({
        sessionId: "s1",
        initialSession: session(),
        client,
        store,
        messenger,
        fetchImpl,
        // autoPoll/pollIntervalMs default (true / 250ms) — same as the
        // plain polling auto-poll test above.
      })

      await controller.onReady()
      const callsAfterInit = getSessionEvents.mock.calls.length
      // Let the SSE connect-then-404-then-fallback chain fully settle
      // (pure microtasks) before advancing real timers.
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(249)
      expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit)
      await vi.advanceTimersByTimeAsync(1)
      expect(getSessionEvents.mock.calls.length).toBe(callsAfterInit + 1)

      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
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

describe("TranscriptPanelController — pasted image attachments", () => {
  it("uploads to the agentproto home (NOT the session cwd) and posts the path back", async () => {
    const client = createMockClient({
      uploadFile: vi.fn().mockResolvedValue({ path: "/home/.agentproto/.agentproto-attachments/paste.png", bytes: 3 }),
    })
    // A session whose cwd is a real repo — the upload must NOT land there.
    const { controller, messenger } = make(client, {
      initialSession: session({ cwd: "/work/my-repo" }),
    })
    const bytes = new Uint8Array([1, 2, 3]).buffer

    await controller.onAttachImage(bytes, "image/png")

    const call = client.uploadFile.mock.calls[0]!
    expect(call[0]).toBe(resolveAttachmentsCwd(process.env, homedir())) // the home, not /work/my-repo
    expect(call[0]).not.toBe("/work/my-repo")
    expect(call[1]).toMatch(/^paste-\d{8}-\d{6}-[0-9a-f]{6}\.png$/) // deterministic-shaped name
    expect(call[2]).toBe(bytes) // bytes passed through untouched, no copy/encode
    expect(call[3]).toBe("image/png")
    expect(messenger.messages).toContainEqual({
      type: "attachmentUploaded",
      path: "/home/.agentproto/.agentproto-attachments/paste.png",
    })
  })

  it("surfaces an upload failure as attachError instead of dropping it silently", async () => {
    const client = createMockClient({
      uploadFile: vi.fn().mockRejectedValue(new Error("HTTP 413 file_too_large")),
    })
    const { controller, messenger } = make(client)

    await controller.onAttachImage(new Uint8Array([0]).buffer, "image/png")

    expect(messenger.messages.some(m => m.type === "attachmentUploaded")).toBe(false)
    expect(messenger.messages).toContainEqual({
      type: "attachError",
      title: "Attachment upload failed",
      message: "HTTP 413 file_too_large",
    })
  })

  it("stores a DRAGGED file under a name derived from its own, keeping the human stem", async () => {
    const client = createMockClient({
      uploadFile: vi.fn().mockResolvedValue({ path: "/home/.agentproto/.agentproto-attachments/report-ab12.pdf", bytes: 3 }),
    })
    const { controller, messenger } = make(client)

    await controller.onAttachFile(new Uint8Array([1, 2, 3]).buffer, "application/pdf", "report.pdf")

    const call = client.uploadFile.mock.calls[0]!
    expect(call[1]).toMatch(/^report-[0-9a-f]{6}\.pdf$/) // human stem + uniqueness suffix
    expect(messenger.messages).toContainEqual({
      type: "attachmentUploaded",
      path: "/home/.agentproto/.agentproto-attachments/report-ab12.pdf",
    })
  })
})

describe("TranscriptPanelController — @file mention candidates", () => {
  it("scopes to the session cwd and returns absolute paths with relative labels", async () => {
    vi.mocked(listRepoFiles).mockResolvedValueOnce(["src/a.ts", "src/webview/b.ts", "README.md"])
    const { controller, messenger } = make(createMockClient(), { initialSession: session({ cwd: "/repo" }) })

    await controller.onRequestMentions("b")

    expect(vi.mocked(listRepoFiles)).toHaveBeenCalledWith("/repo")
    expect(messenger.messages).toContainEqual({
      type: "mentionCandidates",
      query: "b",
      items: [{ path: "/repo/src/webview/b.ts", label: "src/webview/b.ts" }],
    })
  })

  it("returns an empty list (never crashes) when the session has no cwd", async () => {
    vi.mocked(listRepoFiles).mockClear() // shared module mock — forget the prior test's call
    const { controller, messenger } = make(createMockClient(), { initialSession: session({ cwd: undefined }) })

    await controller.onRequestMentions("x")

    expect(messenger.messages).toContainEqual({ type: "mentionCandidates", query: "x", items: [] })
    expect(vi.mocked(listRepoFiles)).not.toHaveBeenCalled()
  })
})
