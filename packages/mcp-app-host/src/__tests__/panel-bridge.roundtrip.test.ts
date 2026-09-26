/**
 * Real round-trip against OUR guest: the shipped `panel-bridge.ts` script
 * every built-in agentproto panel embeds, executed verbatim in a JSDOM
 * window whose `window.parent.postMessage` is wired to the host transport.
 * No hand-rolled model of the guest — if the bridge's handshake params stop
 * passing AppBridge's schema validation, this fails.
 */
import { type DOMWindow, JSDOM } from "jsdom"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { type CallToolResult, type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { panelBridgeScript } from "../../../apps/src/panel-bridge.js"
import { createMcpAppHost } from "../host.js"

interface GuestLogEntry {
  kind: "notify" | "initialized" | "init-error" | "call-result" | "call-error"
  method?: string
  params?: Record<string, unknown>
  hostContext?: Record<string, unknown>
  value?: unknown
  message?: string
}

/** Host half of a postMessage pair with a JSDOM guest. Messages are
 *  JSON-cloned and delivered on a later task, like real postMessage — and,
 *  like a real iframe that hasn't loaded yet, one sent before the guest
 *  window exists is simply lost. `wire` records what crossed, in order. */
class GuestWindowTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  guest: DOMWindow | undefined
  readonly wire: string[] = []

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const guest = this.guest
    const method = "method" in message ? message.method : "response"
    if (!guest) {
      this.wire.push(`lost:${method}`)
      return
    }
    this.wire.push(`out:${method}`)
    const data: unknown = JSON.parse(JSON.stringify(message))
    setTimeout(() => guest.dispatchEvent(new guest.MessageEvent("message", { data })), 0)
  }

  async close(): Promise<void> {
    this.onclose?.()
  }

  /** Called with whatever the guest passed to `window.parent.postMessage`. */
  fromGuest(raw: unknown): void {
    const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(JSON.stringify(raw)))
    if (!parsed.success) return
    this.wire.push(`in:${"method" in parsed.data ? parsed.data.method : "response"}`)
    setTimeout(() => this.onmessage?.(parsed.data), 0)
  }
}

const GUEST_HARNESS = `
window.__log = [];
onHostNotification(function(method, params){ window.__log.push({kind: 'notify', method: method, params: params}); });
initBridge().then(
  function(){ window.__log.push({kind: 'initialized', hostContext: getHostContext()}); },
  function(e){ window.__log.push({kind: 'init-error', message: String(e && e.message)}); }
);
window.__callTool = function(name, args){
  callTool(name, args).then(
    function(value){ window.__log.push({kind: 'call-result', value: value}); },
    function(e){ window.__log.push({kind: 'call-error', message: String(e && e.message)}); }
  );
};
`

const windows: DOMWindow[] = []
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
})

function startGuest(transport: GuestWindowTransport): { window: DOMWindow; log(): GuestLogEntry[] } {
  const html = `<!doctype html><html><head></head><body><script>${panelBridgeScript("roundtrip-panel")}\n${GUEST_HARNESS}</script></body></html>`
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://guest.test/",
    beforeParse(window) {
      transport.guest = window
      Object.defineProperty(window, "parent", {
        configurable: true,
        value: { postMessage: (msg: unknown) => transport.fromGuest(msg) },
      })
    },
  })
  windows.push(dom.window)
  return {
    window: dom.window,
    log(): GuestLogEntry[] {
      const raw: unknown = Reflect.get(dom.window, "__log")
      return JSON.parse(JSON.stringify(raw ?? []))
    },
  }
}

function callFromGuest(window: DOMWindow, name: string, args: Record<string, unknown>): void {
  const fn: unknown = Reflect.get(window, "__callTool")
  if (typeof fn !== "function") throw new Error("guest harness missing __callTool")
  Reflect.apply(fn, window, [name, args])
}

describe("createMcpAppHost ⇄ packages/apps panel-bridge.ts (real guest script)", () => {
  it("initialize → initialized → tool-input → tool-result → tools/call → result", async () => {
    const transport = new GuestWindowTransport()
    const callTool = vi.fn(
      async (params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => ({
        content: [{ type: "text", text: JSON.stringify({ echoed: params.name, args: params.arguments }) }],
      }),
    )
    const host = await createMcpAppHost(transport, {
      hostInfo: { name: "test-host", version: "1.0.0" },
      hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"] },
      handlers: { callTool },
    })

    // Sent BEFORE the guest exists: must be queued until it has initialized,
    // or it is lost (the iframe isn't there to receive it yet).
    const inputSent = host.sendToolInput({ query: "hello" })
    await new Promise((r) => setTimeout(r, 10))

    const guest = startGuest(transport)
    await host.ready
    await inputSent

    await vi.waitFor(() => {
      const log = guest.log()
      expect(log.find((e) => e.kind === "initialized")?.hostContext).toMatchObject({
        theme: "dark",
        displayMode: "inline",
      })
      expect(log).toContainEqual({
        kind: "notify",
        method: "ui/notifications/tool-input",
        params: { arguments: { query: "hello" } },
      })
    })
    expect(guest.log().some((e) => e.kind === "init-error")).toBe(false)
    expect(transport.wire.filter((w) => w.startsWith("lost:"))).toEqual([])
    expect(transport.wire.indexOf("out:ui/notifications/tool-input")).toBeGreaterThan(
      transport.wire.indexOf("in:ui/notifications/initialized"),
    )

    await host.sendToolResult({ content: [{ type: "text", text: "done" }] })
    await vi.waitFor(() =>
      expect(guest.log()).toContainEqual({
        kind: "notify",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "done" }] },
      }),
    )
    // Order on the wire: the queued input precedes the result.
    const methods = guest.log().flatMap((e) => (e.kind === "notify" && e.method ? [e.method] : []))
    expect(methods.indexOf("ui/notifications/tool-input")).toBeLessThan(
      methods.indexOf("ui/notifications/tool-result"),
    )

    callFromGuest(guest.window, "echo", { n: 1 })
    await vi.waitFor(() =>
      expect(guest.log()).toContainEqual({
        kind: "call-result",
        value: { echoed: "echo", args: { n: 1 } },
      }),
    )
    expect(callTool).toHaveBeenCalledWith({ name: "echo", arguments: { n: 1 } })

    await host.teardown()
  })

  it("a handler error reaches the guest's callTool as a rejection", async () => {
    const transport = new GuestWindowTransport()
    const host = await createMcpAppHost(transport, {
      hostInfo: { name: "test-host", version: "1.0.0" },
      hostContext: {},
      handlers: {
        callTool: async () => {
          throw new Error("tool 'nope' is not allowed")
        },
      },
    })
    const guest = startGuest(transport)
    await host.ready

    callFromGuest(guest.window, "nope", {})
    await vi.waitFor(() => {
      const failure = guest.log().find((e) => e.kind === "call-error")
      expect(failure?.message).toContain("tool 'nope' is not allowed")
    })
    await host.teardown()
  })
})
