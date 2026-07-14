import { describe, expect, it, vi } from "vitest"

import { TranscriptPanelController } from "./transcriptPanelController.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import type { ExtMessage } from "./protocol.js"

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

function createMockClient(): DaemonClient & {
  prompt: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  exportSession: ReturnType<typeof vi.fn>
  preview: ReturnType<typeof vi.fn>
  getSession: ReturnType<typeof vi.fn>
} {
  return {
    url: "http://127.0.0.1:18790",
    prompt: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue({ content: "# hello", format: "markdown" }),
    preview: vi.fn().mockResolvedValue({ id: "s1", lines: ["line"], bytes: null }),
    getSession: vi.fn().mockResolvedValue(session()),
  } as unknown as DaemonClient & {
    prompt: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    exportSession: ReturnType<typeof vi.fn>
    preview: ReturnType<typeof vi.fn>
    getSession: ReturnType<typeof vi.fn>
  }
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

describe("TranscriptPanelController", () => {
  it("buffers lines received before ready and emits them after init", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    store.emitLine({ line: "before-ready" })
    expect(messenger.messages).toHaveLength(0)

    await controller.onReady()
    expect(messenger.messages[0]).toMatchObject({ type: "init" })
    expect(messenger.messages).toContainEqual({ type: "lines", lines: [{ line: "before-ready" }] })
  })

  it("preserves the latest pre-ready descriptor and forwards it if it differs from init", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    const store = createMockStore()
    const initial = session({ costUsd: 0 })
    const updated = session({ costUsd: 0.01 })

    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: initial,
      client,
      store,
      messenger,
    })

    controller.onSessionUpdate(updated)
    client.getSession.mockResolvedValue(initial)
    await controller.onReady()

    expect(messenger.messages[0]).toMatchObject({ type: "init", session: initial })
    expect(messenger.messages).toContainEqual({ type: "sessionUpdate", session: updated })
  })

  it("is safe to call onReady multiple times", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    await controller.onReady()
    await controller.onReady()
    expect(messenger.messages.filter((m: ExtMessage) => m.type === "init")).toHaveLength(1)
  })

  it("initializes exactly once when concurrent onReady calls race before hydration", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    let resolveExport: (value: { content: string; format: string }) => void = () => {}
    let resolveGet: (value: SessionDescriptor) => void = () => {}
    client.exportSession.mockImplementation(
      () => new Promise((resolve) => {
        resolveExport = resolve
      }),
    )
    client.getSession.mockImplementation(
      () => new Promise((resolve) => {
        resolveGet = resolve
      }),
    )

    store.emitLine({ line: "buffered" })

    const ready1 = controller.onReady()
    const ready2 = controller.onReady()
    expect(client.exportSession).toHaveBeenCalledTimes(1)
    expect(client.getSession).toHaveBeenCalledTimes(1)

    resolveExport({ content: "# hello", format: "markdown" })
    resolveGet(session())
    await Promise.all([ready1, ready2])

    const inits = messenger.messages.filter((m: ExtMessage) => m.type === "init")
    expect(inits).toHaveLength(1)
    expect(messenger.messages).toContainEqual({ type: "lines", lines: [{ line: "buffered" }] })
    expect(messenger.messages.filter((m: ExtMessage) => m.type === "lines")).toHaveLength(1)
  })

  it("sends fire-and-forget prompts with sending → ack ordering", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    await controller.onSend("hello", false)
    expect(client.prompt).toHaveBeenCalledWith("s1", "hello", { interrupt: false, wait: false })
    expect(messenger.messages.map((m: ExtMessage) => m.type)).toEqual(["sending", "sendAck"])
  })

  it("sends sending → error when prompt fails", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    client.prompt.mockRejectedValue(new Error("boom"))
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    await controller.onSend("hello", true)
    expect(client.prompt).toHaveBeenCalledWith("s1", "hello", { interrupt: true, wait: false })
    expect(messenger.messages[0]).toMatchObject({ type: "sending" })
    expect(messenger.messages[1]).toMatchObject({ type: "sendError", message: "boom" })
  })

  it("suppresses concurrent sends until the admission promise settles", async () => {
    const messenger = createMockMessenger()
    const client = createMockClient()
    let resolvePrompt: (() => void) | undefined
    const promptPromise = new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
    client.prompt.mockImplementation(() => promptPromise)
    const store = createMockStore()
    const controller = new TranscriptPanelController({
      sessionId: "s1",
      initialSession: session(),
      client,
      store,
      messenger,
    })

    const send1 = controller.onSend("first", false)
    const send2 = controller.onSend("second", false)

    // Both calls are in flight, but only one prompt admission and one sending
    // message should have been issued.
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(client.prompt).toHaveBeenLastCalledWith("s1", "first", { interrupt: false, wait: false })
    expect(messenger.messages.filter((m: ExtMessage) => m.type === "sending")).toHaveLength(1)

    resolvePrompt!()
    await send1
    await send2

    expect(messenger.messages.map((m: ExtMessage) => m.type)).toEqual(["sending", "sendAck"])

    // After the first send settles, a new send is accepted again.
    await controller.onSend("third", true)
    expect(client.prompt).toHaveBeenCalledTimes(2)
    expect(client.prompt).toHaveBeenLastCalledWith("s1", "third", { interrupt: true, wait: false })
    expect(messenger.messages.filter((m: ExtMessage) => m.type === "sendAck")).toHaveLength(2)
  })
})
