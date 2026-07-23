import { describe, expect, it, vi } from "vitest"

import { StoryPanelController, type StoryDaemon } from "./storyPanelController.js"

/** A capturing host: collects every message the controller posts back. */
function createHost() {
  const posts: unknown[] = []
  return { posts, post: (msg: unknown) => void posts.push(msg) }
}

function stubDaemon(over: Partial<StoryDaemon> = {}): StoryDaemon {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    exportSession: vi.fn().mockResolvedValue({ content: "{}" }),
    prompt: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

/** Unwrap the panel's callTool envelope: content[0].text JSON-parsed. */
function unwrap(result: unknown): unknown {
  const content = (result as { content?: { text?: string }[] }).content
  return JSON.parse(content?.[0]?.text ?? "null")
}

describe("StoryPanelController", () => {
  it("answers ui/initialize with an inline-only hostContext", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({ daemon: stubDaemon(), post: host.post })

    await ctrl.handleMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} })

    // No sessionId → no auto-open notification, just the handshake result.
    expect(host.posts).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] } },
      },
    ])
  })

  it("pushes a tool-input auto-open notification before the initialize result", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({
      sessionId: "sess_abc",
      daemon: stubDaemon(),
      post: host.post,
    })

    await ctrl.handleMessage({ jsonrpc: "2.0", id: 7, method: "ui/initialize", params: {} })

    // Ordering matters: the panel must have pendingSessionId set (from the
    // notification) by the time initBridge resolves on the result.
    expect(host.posts[0]).toEqual({
      jsonrpc: "2.0",
      method: "tool-input",
      params: { arguments: { sessionId: "sess_abc" } },
    })
    expect(host.posts[1]).toMatchObject({ id: 7, result: { hostContext: expect.anything() } })
  })

  it("ignores notifications (no id) without posting a response", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({ daemon: stubDaemon(), post: host.post })

    await ctrl.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} })

    expect(host.posts).toEqual([])
  })

  it("maps session_list onto daemon.listSessions and wraps { sessions }", async () => {
    const host = createHost()
    const sessions = [{ id: "s1", kind: "agent-cli", status: "running", lastOutputAt: "t0" }]
    const daemon = stubDaemon({ listSessions: vi.fn().mockResolvedValue(sessions) })
    const ctrl = new StoryPanelController({ daemon, post: host.post })

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "session_list", arguments: { kind: "all" } },
    })

    const result = (host.posts[0] as { result: unknown }).result
    expect(unwrap(result)).toEqual({ sessions })
  })

  it("passes agent_export's JSON string through verbatim (no re-stringify)", async () => {
    const host = createHost()
    // The daemon returns the ExportedSession already serialized; the panel
    // parses content[0].text and reads .messages, so it must be handed through
    // unchanged.
    const exportedJson = JSON.stringify({ meta: {}, messages: [{ role: "user", text: "hi" }] })
    const exportSession = vi.fn().mockResolvedValue({ content: exportedJson })
    const daemon = stubDaemon({ exportSession })
    const ctrl = new StoryPanelController({ daemon, post: host.post })

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agent_export", arguments: { sessionId: "s1", format: "json" } },
    })

    expect(exportSession).toHaveBeenCalledWith("s1", "json")
    const result = host.posts[0] as { result: { content: { text: string }[] } }
    // Byte-identical string, and it parses to the expected shape.
    expect(result.result.content[0]!.text).toBe(exportedJson)
    expect(unwrap(result.result)).toEqual({ meta: {}, messages: [{ role: "user", text: "hi" }] })
  })

  it("maps agent_prompt onto a fire-and-forget prompt", async () => {
    const host = createHost()
    const prompt = vi.fn().mockResolvedValue(undefined)
    const daemon = stubDaemon({ prompt })
    const ctrl = new StoryPanelController({ daemon, post: host.post })

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agent_prompt", arguments: { sessionId: "s1", prompt: "go" } },
    })

    expect(prompt).toHaveBeenCalledWith("s1", "go", { wait: false })
    expect(unwrap((host.posts[0] as { result: unknown }).result)).toEqual({ ok: true })
  })

  it("returns a JSON-RPC error for an unknown tool", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({ daemon: stubDaemon(), post: host.post })

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    })

    expect(host.posts[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      error: { message: expect.stringContaining("unsupported tool") },
    })
  })

  it("surfaces a missing sessionId as a JSON-RPC error, not a crash", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({ daemon: stubDaemon(), post: host.post })

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "agent_export", arguments: {} },
    })

    expect(host.posts[0]).toMatchObject({
      id: 6,
      error: { message: expect.stringContaining("sessionId required") },
    })
  })

  it("ignores non-JSON-RPC traffic", async () => {
    const host = createHost()
    const ctrl = new StoryPanelController({ daemon: stubDaemon(), post: host.post })

    await ctrl.handleMessage({ hello: "world" })
    await ctrl.handleMessage(null)
    await ctrl.handleMessage("nope")

    expect(host.posts).toEqual([])
  })
})
