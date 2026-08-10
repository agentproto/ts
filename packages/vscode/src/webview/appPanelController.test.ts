import { describe, expect, it, vi } from "vitest"

import { AppPanelController, type AppDaemon } from "./appPanelController.js"

/** A capturing host: collects every message the controller posts back. */
function createHost() {
  const posts: unknown[] = []
  return { posts, post: (msg: unknown) => void posts.push(msg) }
}

function stubDaemon(over: Partial<AppDaemon> = {}): AppDaemon {
  return {
    appToolCall: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  }
}

function controller(daemon: AppDaemon, post: (msg: unknown) => void): AppPanelController {
  return new AppPanelController({ appId: "mail-triage", daemon, post })
}

/** Unwrap the panel's callTool envelope: content[0].text JSON-parsed. */
function unwrap(result: unknown): unknown {
  const content = (result as { content?: { text?: string }[] }).content
  return JSON.parse(content?.[0]?.text ?? "null")
}

describe("AppPanelController", () => {
  it("answers ui/initialize with an inline-only hostContext", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} })

    expect(host.posts).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] } },
      },
    ])
  })

  it("ignores notifications (no id) without posting a response", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} })

    expect(host.posts).toEqual([])
  })

  it("answers ui/request-display-mode with the one mode it has", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    })

    expect(host.posts).toEqual([{ jsonrpc: "2.0", id: 2, result: { mode: "inline" } }])
  })

  it("accepts-and-drops ui/message and ui/update-model-context with an empty result", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hi" }] },
    })
    await ctrl.handleMessage({ jsonrpc: "2.0", id: 4, method: "ui/update-model-context", params: {} })

    expect(host.posts).toEqual([
      { jsonrpc: "2.0", id: 3, result: {} },
      { jsonrpc: "2.0", id: 4, result: {} },
    ])
  })

  it("unpacks the bridge's app_tool_call routing, pinning the panel's appId", async () => {
    const host = createHost()
    const appToolCall = vi.fn().mockResolvedValue({ mails: [] })
    const ctrl = controller(stubDaemon({ appToolCall }), host.post)

    // The served panels route every tool through app_tool_call themselves
    // (callApp in mail-triage/ui.ts) — the appId they pass is ignored in
    // favour of the panel's own.
    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "app_tool_call",
        arguments: { appId: "some-other-app", tool: "mail_list", args: { folder: "inbox" } },
      },
    })

    expect(appToolCall).toHaveBeenCalledWith("mail-triage", "mail_list", { folder: "inbox" })
    expect(unwrap((host.posts[0] as { result: unknown }).result)).toEqual({ mails: [] })
  })

  it("maps a direct tools/call name onto appToolCall under the panel's appId", async () => {
    const host = createHost()
    const appToolCall = vi.fn().mockResolvedValue({ ok: true })
    const ctrl = controller(stubDaemon({ appToolCall }), host.post)

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "mail_archive", arguments: { id: "m1" } },
    })

    expect(appToolCall).toHaveBeenCalledWith("mail-triage", "mail_archive", { id: "m1" })
    expect(unwrap((host.posts[0] as { result: unknown }).result)).toEqual({ ok: true })
  })

  it("surfaces a daemon tool failure as a JSON-RPC -32000 error", async () => {
    const host = createHost()
    const appToolCall = vi.fn().mockRejectedValue(new Error("not in allowlist"))
    const ctrl = controller(stubDaemon({ appToolCall }), host.post)

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "forbidden_tool", arguments: {} },
    })

    expect(host.posts[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: expect.stringContaining("not in allowlist") },
    })
  })

  it("rejects an app_tool_call with no tool name without hitting the daemon", async () => {
    const host = createHost()
    const appToolCall = vi.fn()
    const ctrl = controller(stubDaemon({ appToolCall }), host.post)

    await ctrl.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "app_tool_call", arguments: {} },
    })

    expect(appToolCall).not.toHaveBeenCalled()
    expect(host.posts[0]).toMatchObject({
      id: 8,
      error: { message: expect.stringContaining("tool required") },
    })
  })

  it("answers an unknown method with a -32601 error", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({ jsonrpc: "2.0", id: 9, method: "ui/does-not-exist", params: {} })

    expect(host.posts[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601, message: expect.stringContaining("unsupported method") },
    })
  })

  it("ignores non-JSON-RPC traffic", async () => {
    const host = createHost()
    const ctrl = controller(stubDaemon(), host.post)

    await ctrl.handleMessage({ hello: "world" })
    await ctrl.handleMessage(null)
    await ctrl.handleMessage("nope")

    expect(host.posts).toEqual([])
  })
})
