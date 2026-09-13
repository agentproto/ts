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
    // Default hostContext with no advertised modes — keeps #dm/#pin hidden.
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
    // Both paths share the same isError/JSON-unwrap logic — not duplicated.
    expect(callFn.match(/isError/g)).toHaveLength(1)
  })

  it("compiles as valid JavaScript", () => {
    expect(() => new Function(js)).not.toThrow()
  })
})
