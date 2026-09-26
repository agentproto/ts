/**
 * createMcpAppHost against ext-apps' OWN guest: the official `App` class,
 * connected over the SDK's in-memory linked transport pair. Nothing about
 * the protocol is mocked — only the embedder's handlers are.
 */
import { App } from "@modelcontextprotocol/ext-apps"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMcpAppHost, type McpAppHost, type McpAppHostHandlers, type McpUiHostContext } from "../host.js"

const HOST_INFO = { name: "test-host", version: "1.0.0" }
const OK: CallToolResult = { content: [{ type: "text", text: "ok" }] }

/**
 * Wraps the host end of the pair and records every method that crosses it,
 * in order. The SDK's InMemoryTransport buffers messages until its peer
 * starts — a real postMessage to a not-yet-loaded iframe does not — so
 * "the view eventually got it" can't prove the host held it back; the wire
 * order can.
 */
class RecordingTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void
  readonly wire: string[] = []

  constructor(private readonly inner: Transport) {}

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.wire.push(`in:${"method" in message ? message.method : "response"}`)
      this.onmessage?.(message, extra)
    }
    this.inner.onclose = () => this.onclose?.()
    this.inner.onerror = (error) => this.onerror?.(error)
    await this.inner.start()
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.wire.push(`out:${"method" in message ? message.method : "response"}`)
    await this.inner.send(message, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(
  handlers: Partial<McpAppHostHandlers> = {},
  hostContext: McpUiHostContext = { displayMode: "inline", availableDisplayModes: ["inline"] },
): Promise<{ host: McpAppHost; app: App; wire: string[]; connect(): Promise<void> }> {
  const [viewTransport, inner] = InMemoryTransport.createLinkedPair()
  const hostTransport = new RecordingTransport(inner)
  const host = await createMcpAppHost(hostTransport, {
    hostInfo: HOST_INFO,
    hostContext,
    handlers: { callTool: async () => OK, ...handlers },
  })
  const app = new App({ name: "test-view", version: "0.0.1" }, {}, { autoResize: false })
  cleanups.push(async () => {
    await app.close().catch(() => {})
    await host.teardown().catch(() => {})
  })
  return {
    host,
    app,
    wire: hostTransport.wire,
    async connect() {
      await app.connect(viewTransport)
      await host.ready
    },
  }
}

describe("createMcpAppHost × ext-apps App", () => {
  it("handshake → tool-input → tool-result → view tools/call reaches handlers.callTool", async () => {
    const callTool = vi.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "from host" }],
      structuredContent: { answer: 42 },
    }))
    const { host, app, connect } = await setup({ callTool }, { theme: "light", displayMode: "inline" })
    const inputs: unknown[] = []
    const results: unknown[] = []
    app.ontoolinput = (params) => inputs.push(params)
    app.ontoolresult = (params) => results.push(params)

    await connect()
    expect(app.getHostVersion()).toEqual(HOST_INFO)
    expect(app.getHostContext()).toMatchObject({ theme: "light", displayMode: "inline" })

    await host.sendToolInput({ city: "Paris" })
    await host.sendToolResult(OK)
    await vi.waitFor(() => {
      expect(inputs).toEqual([{ arguments: { city: "Paris" } }])
      expect(results).toEqual([OK])
    })

    const result = await app.callServerTool({ name: "weather", arguments: { city: "Paris" } })
    expect(callTool).toHaveBeenCalledWith({ name: "weather", arguments: { city: "Paris" } })
    expect(result.structuredContent).toEqual({ answer: 42 })
  })

  it("queues tool-input / tool-result sent before ready and flushes them in order", async () => {
    const { host, app, wire, connect } = await setup()
    const seen: string[] = []
    app.ontoolinput = () => seen.push("input")
    app.ontoolresult = () => seen.push("result")
    app.ontoolcancelled = () => seen.push("cancelled")

    const sends = [host.sendToolInput({ a: 1 }), host.sendToolResult(OK), host.sendToolCancelled("user")]
    // Nothing can have been delivered: the view hasn't even connected.
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual([])
    expect(wire).toEqual([])

    await connect()
    await Promise.all(sends)
    await vi.waitFor(() => expect(seen).toEqual(["input", "result", "cancelled"]))
    expect(wire).toEqual([
      "in:ui/initialize",
      "out:response",
      "in:ui/notifications/initialized",
      "out:ui/notifications/tool-input",
      "out:ui/notifications/tool-result",
      "out:ui/notifications/tool-cancelled",
    ])
  })

  it("rejects `ready` and queued sends when the transport closes before initialize", async () => {
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
    const host = await createMcpAppHost(hostTransport, {
      hostInfo: HOST_INFO,
      hostContext: {},
      handlers: { callTool: async () => OK },
    })
    const queued = host.sendToolInput({ a: 1 })
    await viewTransport.close()
    await expect(host.ready).rejects.toThrow(/closed before the view initialized/)
    await expect(queued).rejects.toThrow()
    await expect(host.sendToolResult(OK)).rejects.toThrow(/torn down/)
  })

  it("advertises only the capabilities it has handlers for", async () => {
    const bare = await setup()
    await bare.connect()
    expect(bare.app.getHostCapabilities()).toEqual({ serverTools: {} })

    const full = await setup({
      openLink: async () => {},
      onLog: () => {},
      sendMessage: async () => {},
      updateModelContext: async () => {},
    })
    await full.connect()
    expect(full.app.getHostCapabilities()).toMatchObject({
      serverTools: {},
      openLinks: {},
      logging: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    })
  })

  describe("missing handlers", () => {
    it("ui/message and ui/update-model-context accept and drop", async () => {
      const { app, connect } = await setup()
      await connect()
      await expect(
        app.sendMessage({ role: "user", content: [{ type: "text", text: "hi" }] }),
      ).resolves.toEqual({})
      await expect(app.updateModelContext({ content: [{ type: "text", text: "ctx" }] })).resolves.toEqual({})
    })

    it("ui/open-link answers with a JSON-RPC error", async () => {
      const { app, connect } = await setup()
      await connect()
      await expect(app.openLink({ url: "https://example.com" })).rejects.toThrow(/Method not found/)
    })

    it("ui/request-display-mode keeps AppBridge's default: reply with the current mode", async () => {
      const { app, connect } = await setup({}, { displayMode: "inline", availableDisplayModes: ["inline"] })
      await connect()
      await expect(app.requestDisplayMode({ mode: "fullscreen" })).resolves.toEqual({ mode: "inline" })
    })
  })

  describe("handlers present", () => {
    it("ui/message resolves {} when the handler accepts, errors when it rejects", async () => {
      const sendMessage = vi.fn(async () => {})
      const { app, connect } = await setup({ sendMessage })
      await connect()
      const params = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] }
      await expect(app.sendMessage(params)).resolves.toEqual({})
      expect(sendMessage).toHaveBeenCalledWith(params)

      sendMessage.mockRejectedValueOnce(new Error("session is busy"))
      await expect(app.sendMessage(params)).rejects.toThrow(/session is busy/)
    })

    it("ui/update-model-context forwards to the handler", async () => {
      const updateModelContext = vi.fn(async () => {})
      const { app, connect } = await setup({ updateModelContext })
      await connect()
      await app.updateModelContext({ structuredContent: { picked: 3 } })
      expect(updateModelContext).toHaveBeenCalledWith({ structuredContent: { picked: 3 } })
    })

    it("ui/open-link calls openLink(url)", async () => {
      const openLink = vi.fn(async () => {})
      const { app, connect } = await setup({ openLink })
      await connect()
      await expect(app.openLink({ url: "https://example.com/x" })).resolves.toEqual({})
      expect(openLink).toHaveBeenCalledWith("https://example.com/x")
    })

    it("ui/request-display-mode returns the granted mode and pushes it as host context", async () => {
      const requestDisplayMode = vi.fn(async () => "fullscreen" as const)
      const { app, connect } = await setup(
        { requestDisplayMode },
        { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
      )
      const changes: unknown[] = []
      app.onhostcontextchanged = (params) => changes.push(params)
      await connect()
      await expect(app.requestDisplayMode({ mode: "fullscreen" })).resolves.toEqual({ mode: "fullscreen" })
      expect(requestDisplayMode).toHaveBeenCalledWith("fullscreen")
      await vi.waitFor(() => expect(changes).toContainEqual({ displayMode: "fullscreen" }))
      expect(app.getHostContext()?.displayMode).toBe("fullscreen")
    })

    it("size-changed → onSizeChanged", async () => {
      const onSizeChanged = vi.fn()
      const { app, connect } = await setup({ onSizeChanged })
      await connect()
      await app.sendSizeChanged({ width: 320, height: 240 })
      await vi.waitFor(() => expect(onSizeChanged).toHaveBeenCalledWith({ width: 320, height: 240 }))
    })

    it("notifications/message → onLog, request-teardown → onTeardownRequested", async () => {
      const onLog = vi.fn()
      const onTeardownRequested = vi.fn()
      const { app, connect } = await setup({ onLog, onTeardownRequested })
      await connect()
      await app.sendLog({ level: "info", data: "hello" })
      await app.requestTeardown()
      await vi.waitFor(() => {
        expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ level: "info", data: "hello" }))
        expect(onTeardownRequested).toHaveBeenCalledTimes(1)
      })
    })
  })

  it("setHostContext merges and notifies only the changed keys", async () => {
    const { host, app, connect } = await setup({}, { theme: "light", locale: "fr-FR" })
    const changes: unknown[] = []
    app.onhostcontextchanged = (params) => changes.push(params)
    await connect()
    await host.setHostContext({ theme: "dark" })
    await vi.waitFor(() => expect(changes).toEqual([{ theme: "dark" }]))
    expect(app.getHostContext()).toMatchObject({ theme: "dark", locale: "fr-FR" })
  })

  it("teardown sends ui/resource-teardown and waits for the view's answer", async () => {
    const { host, app, connect } = await setup()
    const onteardown = vi.fn(async () => ({}))
    app.onteardown = onteardown
    await connect()
    await host.teardown()
    expect(onteardown).toHaveBeenCalledTimes(1)
    await expect(host.sendToolInput({})).rejects.toThrow(/torn down/)
  })
})
