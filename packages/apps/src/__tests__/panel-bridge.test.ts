/**
 * Static coverage for panel-bridge.ts's standalone-mode detection — the
 * dynamic, real-DOM coverage (does a served builtin panel actually leave
 * "Connecting to bridge…" and render) lives in packages/vscode as a jsdom
 * `.dom.test.ts`, since packages/apps has no jsdom dependency to execute the
 * emitted script against a real document. This file guards the emitted
 * string: the discriminator's shape, that both code paths (standalone via
 * `window.McpApp`, and postMessage via `rpcRequest`) are present, and that
 * the postMessage path's wire format is untouched.
 */

import { describe, it, expect } from "vitest"
import { DISPLAY_MODE_SCRIPT_BODY } from "@agentproto/app-client/display-mode"
import { panelBridgeScript } from "../panel-bridge.js"

const js = panelBridgeScript("agentproto-test-panel")

describe("panelBridgeScript standalone detection", () => {
  it("requires both window.parent === window and a working window.McpApp.connect", () => {
    // window.McpApp presence alone is not the discriminator — the VS Code
    // srcdoc relay never defines window.McpApp for a builtin panel, but
    // window.parent === window is the direct signal ("is there a host to
    // postMessage?") and doesn't depend on which injector ran.
    expect(js).toContain("window.parent === window")
    expect(js).toContain("window.McpApp")
    expect(js).toContain("typeof window.McpApp.connect === 'function'")
  })

  it("short-circuits initBridge() locally in standalone mode, no rpcRequest round trip", () => {
    const initFn = js.slice(js.indexOf("function initBridge"), js.indexOf("function requestDisplayMode"))
    expect(initFn).toContain("_isStandalone()")
    expect(initFn).toContain("window.McpApp.connect()")
    // Default hostContext with no advertised modes — keeps the toggle hidden.
    expect(initFn).toContain("availableDisplayModes: []")
    expect(initFn).toContain("displayMode: 'inline'")
  })

  it("still sends the spec-correct postMessage handshake when not standalone", () => {
    expect(js).toContain("ui/initialize")
    expect(js).toContain("appInfo")
    expect(js).toContain("ui/notifications/initialized")
    expect(js).toContain("['inline', 'fullscreen', 'pip']")
  })

  it("routes callTool through window.McpApp when standalone, tools/call otherwise", () => {
    const callFn = js.slice(js.indexOf("function callTool"), js.indexOf("// ── Display-mode"))
    expect(callFn).toContain("_standaloneApp")
    expect(callFn).toContain(".callTool(name, args || {})")
    expect(callFn).toContain("rpcRequest('tools/call'")
    // Both paths share the same envelope-unwrap logic — not duplicated.
    expect(callFn).toContain(".then(_unwrapToolResult)")
    expect(callFn).not.toContain("isError")
    expect(js.match(/env\.isError/g)).toHaveLength(1)
  })

  it("compiles as valid JavaScript", () => {
    expect(() => new Function(js)).not.toThrow()
  })
})

describe("panelBridgeScript display-mode toggle", () => {
  it("inlines the shared installer rather than a per-panel copy of the button", () => {
    // The behaviour itself is covered where it can actually be executed:
    // @agentproto/app-client's display-mode.test.ts runs the same emitted
    // script under happy-dom. This guards the wiring — that panels get the
    // SHARED implementation, once, with their own plumbing handed to it.
    expect(js).toContain(DISPLAY_MODE_SCRIPT_BODY)
    expect(js.match(/installDisplayMode = function/g)).toHaveLength(1)
  })

  it("hands it this panel's host-context and request plumbing", () => {
    const wiring = js.slice(js.indexOf("window.AgentprotoUI.installDisplayMode({"))
    expect(wiring).toContain("getHostContext: getHostContext")
    expect(wiring).toContain("onHostContext: onHostContext")
    expect(wiring).toContain("requestDisplayMode: requestDisplayMode")
  })

  it("leaves installDisplayMode on window.AgentprotoUI for a panel with its own header", () => {
    // A panel that wants the toggle inline calls mountToggle(el) on the
    // controller instead of taking the floating one.
    expect(js).toContain("window.AgentprotoUI.installDisplayMode =")
    expect(js).toContain("mountToggle: mountToggle")
  })
})

describe("panelBridgeScript callTool envelope unwrap", () => {
  // Evaluate just the emitted callTool + unwrap helpers against a stubbed
  // transport — the rest of the script needs a real window/document.
  const start = js.indexOf("// An MCP tool-result envelope")
  const end = js.indexOf("// ── Display-mode")
  const factory = new Function(
    "rpcRequest",
    "_standaloneApp",
    `${js.slice(start, end)}\nreturn callTool;`,
  ) as (rpc: unknown, standalone: unknown) => (name: string, args?: unknown) => Promise<unknown>

  const text = (value: string, isError?: true) => ({
    content: [{ type: "text", text: value }],
    ...(isError ? { isError } : {}),
  })
  const envelope = (data: unknown) => text(JSON.stringify(data))
  const rows = [{ appId: "@acme/greeter", category: "builtin" }]

  const viaHost = (result: unknown) => factory(() => Promise.resolve(result), null)("app_catalog")
  const viaStandalone = (result: unknown) =>
    factory(null, { callTool: () => Promise.resolve(result) })("app_catalog")

  it("returns the parsed payload of a single-wrapped result (postMessage host path)", async () => {
    await expect(viaHost(envelope(rows))).resolves.toEqual(rows)
  })

  it("peels the second wrap the standalone tool-call route adds", async () => {
    const doubled = text(JSON.stringify(envelope(rows)))
    await expect(viaStandalone(doubled)).resolves.toEqual(rows)
    await expect(viaStandalone(text(JSON.stringify(doubled)))).resolves.toEqual(rows)
  })

  it("throws the inner text when an inner layer is an error under an outer success", async () => {
    const inner = text("boom", true)
    await expect(viaStandalone(text(JSON.stringify(inner)))).rejects.toThrow("boom")
  })

  it("throws on an outer isError", async () => {
    await expect(viaHost(text("nope", true))).rejects.toThrow("nope")
    await expect(viaHost({ isError: true })).rejects.toThrow("tool error")
  })

  it("returns non-JSON text as the string and does not mistake plain objects for envelopes", async () => {
    await expect(viaHost(text("plain words"))).resolves.toBe("plain words")
    await expect(viaHost(envelope({ content: "not an array" }))).resolves.toEqual({ content: "not an array" })
    await expect(viaHost({ content: [] })).resolves.toEqual({})
  })
})
