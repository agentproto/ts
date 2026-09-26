/**
 * Unit coverage for app-ui-apps.ts — the AppRegistry → AgnoMcpApp[] bridge
 * that mounts installed apps' `ui` panels (app_ui_<slug>) next to the
 * built-in ones. No McpServer here — see the tools/list integration test
 * in app-tools.test.ts for the end-to-end wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import {
  appUiToolId,
  createUiHtmlCache,
  injectMcpAppBridge,
  injectStandaloneAppBridge,
  makeInstalledAppUiApps,
  MCP_APP_BRIDGE_SCRIPT,
  STANDALONE_REST_BRIDGE_SCRIPT,
} from "../app-ui-apps.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"

describe("appUiToolId", () => {
  it("strips an @owner/ prefix and maps non-alnum chars to underscores", () => {
    expect(appUiToolId("@test/fixture-app")).toBe("app_ui_fixture_app")
  })
  it("passes through an unscoped id, mapping punctuation", () => {
    expect(appUiToolId("my.app")).toBe("app_ui_my_app")
  })
})

describe("makeInstalledAppUiApps", () => {
  let dir: string
  let appRegistry: AppRegistry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-ui-apps-test-"))
    appRegistry = createAppRegistry()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("builds exactly one AgnoMcpApp for the one installed app with a ui block", async () => {
    const uiPath = join(dir, "index.html")
    await writeFile(uiPath, "<html><body>Panel</body></html>", "utf8")

    appRegistry.upsertApp({
      appId: "@test/no-ui-app",
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    })
    appRegistry.upsertApp({
      appId: "@test/ui-app",
      dir,
      name: "UI App",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: uiPath, title: "Panel", tools: ["read_file"] },
    })

    const cache = createUiHtmlCache()
    const apps = await makeInstalledAppUiApps(appRegistry, cache, new Set())

    expect(apps).toHaveLength(1)
    expect(apps[0]!.id).toBe("app_ui_ui_app")
    expect(apps[0]!.title).toBe("Panel")
    // Served html is the source plus the injected McpApp bridge — not a
    // byte-for-byte passthrough of what's on disk.
    expect(apps[0]!.html).toContain("Panel")
    expect(apps[0]!.html).toContain("window.McpApp")
    const initData = await apps[0]!.execute!({})
    expect(initData).toEqual({ appId: "@test/ui-app", tools: ["read_file"] })
  })

  it("skips an app whose derived tool id collides with an existing tool, with a console.warn", async () => {
    const uiPath = join(dir, "index.html")
    await writeFile(uiPath, "<html></html>", "utf8")
    appRegistry.upsertApp({
      appId: "@test/collide-app",
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: uiPath },
    })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cache = createUiHtmlCache()
    const apps = await makeInstalledAppUiApps(
      appRegistry,
      cache,
      new Set([appUiToolId("@test/collide-app")]),
    )

    expect(apps).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain("collide")
    warnSpy.mockRestore()
  })

  it("skips an app whose ui.path can't be read, with a console.warn", async () => {
    appRegistry.upsertApp({
      appId: "@test/unreadable-app",
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: join(dir, "does-not-exist.html") },
    })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cache = createUiHtmlCache()
    const apps = await makeInstalledAppUiApps(appRegistry, cache, new Set())

    expect(apps).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain("unreadable-app")
    warnSpy.mockRestore()
  })

  it("caches HTML (post bridge-injection) by (path, version) and re-reads only on a version change", async () => {
    const uiPath = join(dir, "index.html")
    await writeFile(uiPath, "v1", "utf8")

    const cache = createUiHtmlCache()
    const first = await cache.get(uiPath, "2026-01-01T00:00:00.000Z")
    expect(first).toContain("v1")
    expect(first).toContain("window.McpApp")

    await writeFile(uiPath, "v2", "utf8")
    // Same version — still cached, doesn't pick up the on-disk change.
    expect(await cache.get(uiPath, "2026-01-01T00:00:00.000Z")).toBe(first)
    // New version — re-reads.
    const second = await cache.get(uiPath, "2026-01-02T00:00:00.000Z")
    expect(second).toContain("v2")
    expect(second).toContain("window.McpApp")
  })
})

describe("injectMcpAppBridge", () => {
  it("injects the bridge right after <head> when present", () => {
    const html = "<html><head><title>t</title></head><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    expect(out).toContain("window.McpApp")
    expect(out).toContain('__AGENTPROTO_UI_TRANSPORT__ = "mcp"')
    expect(out.indexOf("window.McpApp")).toBeLessThan(out.indexOf("<title>"))
  })

  it("falls back to <body> when there is no <head>", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    expect(out.indexOf("window.McpApp")).toBeLessThan(out.indexOf("Panel"))
  })

  it("falls back to prepending when there is no structural tag at all", () => {
    const html = "Panel"
    const out = injectMcpAppBridge(html)
    expect(out.indexOf("window.McpApp")).toBeLessThan(out.indexOf("Panel"))
  })

  it("is idempotent: a no-op when the html already defines window.McpApp AND window.AgentprotoUI", () => {
    const html =
      "<html><head><script>window.McpApp = {}; window.AgentprotoUI = {};</script></head><body>Panel</body></html>"
    expect(injectMcpAppBridge(html)).toBe(html)
  })

  it("still injects the runner-select script when window.McpApp is already defined but window.AgentprotoUI isn't", () => {
    const html = "<html><head><script>window.McpApp = {};</script></head><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    expect(out).toContain("AgentprotoUI")
    expect(out).not.toContain("ui/initialize")
  })

  it("also injects the runner-select script, after the bridge", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    expect(out).toContain("AgentprotoUI")
    expect(out.indexOf("window.McpApp")).toBeLessThan(out.indexOf("AgentprotoUI"))
  })

  it("still injects when the html only CONSUMES window.McpApp.connect()", () => {
    // Every bundled app panel calls window.McpApp.connect() — a guard that
    // matches any mention of window.McpApp would skip injection for exactly
    // the documents that need the bridge, leaving connect() to throw in the
    // host iframe (mail-triage's "Not connected to host bridge" symptom).
    const html =
      "<html><head><title>t</title></head><body><script>window.McpApp.connect();</script></body></html>"
    const out = injectMcpAppBridge(html)
    expect(out).toContain("ui/initialize")
    expect(out.indexOf("ui/initialize")).toBeLessThan(out.indexOf("window.McpApp.connect()"))
  })

  it("only injects the bridge once even if run twice", () => {
    const html = "<html><body>Panel</body></html>"
    const once = injectMcpAppBridge(html)
    const twice = injectMcpAppBridge(once)
    expect(twice).toBe(once)
  })

  it("injects the bridge with updateModelContext, openLink, and onTeardown methods", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    expect(out).toContain("updateModelContext")
    expect(out).toContain("openLink")
    expect(out).toContain("onTeardown")
    expect(out).toContain("ui/update-model-context")
    expect(out).toContain("ui/open-link")
    expect(out).toContain("ui/resource-teardown")
  })

  it("bridge handles ui/resource-teardown by responding with result and calling registered callbacks", () => {
    // Simulate: the script defines teardownCbs array, onTeardown pushes,
    // and the message listener calls them + posts response.
    const html = "<html><body>Panel</body></html>"
    const out = injectMcpAppBridge(html)
    // The handler should post back {jsonrpc:"2.0", id, result:{}} for teardown
    expect(out).toContain('result: {}')
    expect(out).toContain("teardownCbs")
    expect(out).toContain("teardownCbs.push")
    expect(out).toContain("teardownCbs[i]()")
  })
})

describe("injectStandaloneAppBridge", () => {
  it("injects the REST bridge after <head>, before the app's own scripts", () => {
    const html =
      "<html><head><title>t</title></head><body><script>window.McpApp.connect();</script></body></html>"
    const out = injectStandaloneAppBridge(html)
    expect(out).toContain('fetch("./tool-call"')
    expect(out).toContain('__AGENTPROTO_UI_TRANSPORT__ = "http"')
    // The app html referencing window.McpApp must NOT suppress injection
    // (unlike injectMcpAppBridge's idempotence check) — every bundled UI
    // calls window.McpApp.connect(), and standalone serving still needs
    // the bridge defined first.
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("window.McpApp.connect()"))
  })

  it("injects the daemon base URL before the standalone bridge when supplied", () => {
    const html = "<html><head></head><body>Panel</body></html>"
    const out = injectStandaloneAppBridge(html, "https://localhost:18791")
    expect(out).toContain(
      'window.__AGENTPROTO_BASEURL__="https://localhost:18791"',
    )
    expect(out.indexOf("__AGENTPROTO_BASEURL__")).toBeLessThan(
      out.indexOf("__AGENTPROTO_UI_TRANSPORT__"),
    )
  })

  it("escapes a closing script sequence in the injected daemon base URL", () => {
    const html = "<html><head></head><body>Panel</body></html>"
    const out = injectStandaloneAppBridge(
      html,
      "https://example.test/</script><script>alert(1)</script>",
    )
    expect(out).not.toContain("</script><script>alert(1)</script>")
    expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>")
  })

  it("falls back to prepending when there is no structural tag at all", () => {
    const out = injectStandaloneAppBridge("Panel")
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("Panel"))
  })

  it("injects standalone bridge with updateModelContext, openLink, and onTeardown", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectStandaloneAppBridge(html)
    expect(out).toContain("updateModelContext")
    expect(out).toContain("openLink")
    expect(out).toContain("onTeardown")
    expect(out).toContain("window.open")
  })

  it("also injects the runner-select script, after the standalone bridge", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectStandaloneAppBridge(html)
    expect(out).toContain("mountRunnerSelect")
    // Matched on the definition, not the bare `AgentprotoUI` name: the
    // bridge itself now reaches for that namespace (installDisplayMode), so
    // the name alone no longer marks where the injected scripts begin.
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("mountRunnerSelect ="))
  })

  it("does not re-inject the runner-select script on a second pass", () => {
    const html = "<html><body>Panel</body></html>"
    const once = injectStandaloneAppBridge(html)
    const twice = injectStandaloneAppBridge(once)
    expect(twice.match(/mountRunnerSelect = function/g)).toHaveLength(1)
  })
})

/**
 * Executes the REAL `STANDALONE_REST_BRIDGE_SCRIPT` in a `vm` sandbox (the
 * script only touches `window` / `fetch` / `Promise` / `JSON` / `Error`, no
 * DOM) with a stubbed `fetch`, so the precedence between a route's
 * `message`, its machine `error` slug, and the HTTP status is asserted on
 * behavior rather than on the emitted string.
 */
interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

interface StandaloneConn {
  callTool: (name: string, args?: unknown) => Promise<unknown>
}

function loadStandaloneBridge(fetchImpl: () => Promise<FakeResponse>): {
  connect: () => Promise<StandaloneConn>
} {
  const windowObj: Record<string, unknown> = {}
  const sandbox: Record<string, unknown> = {
    window: windowObj,
    fetch: fetchImpl,
    Promise,
    JSON,
    Error,
  }
  const js = STANDALONE_REST_BRIDGE_SCRIPT.replace("<script>", "").replace("</script>", "")
  runInNewContext(js, sandbox)
  return windowObj.McpApp as { connect: () => Promise<StandaloneConn> }
}

function response(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

async function callToolError(res: FakeResponse): Promise<string> {
  const bridge = loadStandaloneBridge(() => Promise.resolve(res))
  const conn = await bridge.connect()
  try {
    await conn.callTool("rendezvous_send", {})
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error("expected callTool to reject on a non-ok response")
}

describe("STANDALONE_REST_BRIDGE_SCRIPT callTool error precedence", () => {
  it("surfaces body.message, not the machine slug, when both are present", async () => {
    const message =
      "MCP error -32600: rendezvous_send: this principal token was derived read-only, " +
      "so it can list your rooms but not speak in them. The send capability is part " +
      "of the token itself, not a setting — mint a new one with `principal-token " +
      "<provider> <contactRef> --can-send`."
    expect(await callToolError(response(502, { error: "tool_call_failed", message }))).toBe(message)
  })

  it("falls back to the body.error slug when there is no message", async () => {
    expect(await callToolError(response(502, { error: "tool_call_failed" }))).toBe("tool_call_failed")
  })

  it("surfaces the HTTP status when the body is unparseable", async () => {
    const res: FakeResponse = {
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    }
    expect(await callToolError(res)).toBe("tool-call failed: HTTP 502")
  })

  // Every error framing app-serve.ts can emit carries its human reason in
  // `message`; fix the precedence for all of them, not just the 502 slug.
  const envelopes: [number, { error: string; message: string }][] = [
    [400, { error: "bad_request", message: 'body must be `{ "name": string, args?: object }`.' }],
    [403, { error: "forbidden", message: 'tool "x" is not in this app\'s ui.tools allowlist: a' }],
    [502, { error: "tool_call_failed", message: "MCP error -32600: read-only token" }],
    [502, { error: "daemon_unreachable", message: "could not reach the MCP endpoint: ECONNREFUSED." }],
  ]
  for (const [status, body] of envelopes) {
    it(`surfaces the message for the ${status} ${body.error} envelope`, async () => {
      expect(await callToolError(response(status, body))).toBe(body.message)
    })
  }
})

/**
 * The display-mode surface of the injected postMessage bridge
 * (`MCP_APP_BRIDGE_SCRIPT`). Installed apps had NO toggle at all before this
 * — they could never leave `inline` — and the bridge ignored
 * `ui/notifications/host-context-changed` entirely, so it had nothing to
 * drive one with. The button itself is not re-tested here: it lives in
 * `@agentproto/app-client/display-mode` and is executed against a real DOM
 * by that package's `display-mode.test.ts`. This covers the wiring — host
 * context in, `window.McpApp.displayMode` out.
 *
 * Executed in a `vm` sandbox with a fake `window` (the script touches
 * `window.parent.postMessage` / `addEventListener` and no DOM), so the
 * assertions are on behaviour rather than on the emitted string.
 */
interface BridgeHarness {
  mcpApp: {
    connect: (opts?: { displayToggle?: string }) => Promise<Record<string, unknown>>
    displayMode?: Record<string, unknown>
  }
  posted: Array<Record<string, unknown>>
  deliver: (msg: unknown) => void
}

function loadPostMessageBridge(agentprotoUI?: unknown): BridgeHarness {
  const posted: Array<Record<string, unknown>> = []
  const listeners: Array<(e: { data: unknown }) => void> = []
  const windowObj: Record<string, unknown> = {
    // A distinct object from `window` — the script's standalone check is
    // `window.parent === window`, and this harness is the HOSTED path.
    parent: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
    addEventListener: (_type: string, cb: (e: { data: unknown }) => void) => listeners.push(cb),
  }
  if (agentprotoUI) windowObj.AgentprotoUI = agentprotoUI
  const sandbox: Record<string, unknown> = {
    window: windowObj,
    Promise,
    JSON,
    Error,
    Object,
    console,
  }
  const js = MCP_APP_BRIDGE_SCRIPT.replace("<script>", "").replace("</script>", "")
  runInNewContext(js, sandbox)
  return {
    mcpApp: windowObj.McpApp as BridgeHarness["mcpApp"],
    posted,
    deliver: (msg) => {
      for (const cb of listeners) cb({ data: msg })
    },
  }
}

/** Answer the pending `ui/initialize` with `hostContext`, as a host does. */
async function connectWith(
  bridge: BridgeHarness,
  hostContext: Record<string, unknown> | undefined,
  opts?: { displayToggle?: string },
): Promise<Record<string, unknown>> {
  const pending = bridge.mcpApp.connect(opts)
  const init = bridge.posted.find(m => m.method === "ui/initialize")
  bridge.deliver({
    jsonrpc: "2.0",
    id: init?.id,
    result: hostContext ? { hostContext } : {},
  })
  return pending
}

describe("MCP_APP_BRIDGE_SCRIPT display mode", () => {
  it("captures the hostContext carried by the ui/initialize result", async () => {
    const bridge = loadPostMessageBridge()
    const conn = await connectWith(bridge, {
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      safeAreaInsets: { top: 48, right: 12, bottom: 0, left: 0 },
    })
    const ctx = (conn.getHostContext as () => Record<string, unknown>)()
    expect(ctx.availableDisplayModes).toEqual(["inline", "fullscreen"])
    expect(ctx.safeAreaInsets).toEqual({ top: 48, right: 12, bottom: 0, left: 0 })
  })

  it("merges ui/notifications/host-context-changed and replays to subscribers", async () => {
    const bridge = loadPostMessageBridge()
    const conn = await connectWith(bridge, {
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    })
    const seen: Array<Record<string, unknown>> = []
    ;(conn.onHostContext as (cb: (c: Record<string, unknown>) => void) => void)(c => seen.push(c))
    // Replayed immediately — a late subscriber isn't stuck blind.
    expect(seen).toHaveLength(1)

    // The notification carries only the changed keys; the rest must survive.
    bridge.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    })
  })

  it("publishes the controller on window.McpApp and on the connection", async () => {
    const bridge = loadPostMessageBridge()
    const conn = await connectWith(bridge, { availableDisplayModes: ["fullscreen"] })
    expect(bridge.mcpApp.displayMode).toBeTruthy()
    expect(conn.displayMode).toBe(bridge.mcpApp.displayMode)

    const dm = conn.displayMode as { available: () => string[]; request: (m: string) => Promise<unknown> }
    expect(dm.available()).toEqual(["fullscreen"])

    void dm.request("fullscreen")
    const req = bridge.posted.find(m => m.method === "ui/request-display-mode")
    expect(req?.params).toEqual({ mode: "fullscreen" })
  })

  it("forwards connect({displayToggle}) to the shared installer as its toggle option", async () => {
    const calls: Array<unknown> = []
    const bridge = loadPostMessageBridge({
      installDisplayMode: (_api: unknown, opts: unknown) => {
        calls.push(opts)
        return { get: () => "inline", available: () => [], mountToggle: () => null }
      },
    })
    await connectWith(bridge, {}, { displayToggle: "none" })
    expect(calls).toEqual([{ toggle: "none" }])
  })

  it("passes no options through when the app asks for nothing", async () => {
    const calls: Array<unknown> = []
    const bridge = loadPostMessageBridge({
      installDisplayMode: (_api: unknown, opts: unknown) => {
        calls.push(opts)
        return { get: () => "inline", available: () => [], mountToggle: () => null }
      },
    })
    await connectWith(bridge, {})
    expect(calls).toEqual([null])
  })

  it("hands the installer plumbing that reaches the host", async () => {
    let captured: { requestDisplayMode: (m: string) => Promise<unknown> } | undefined
    const bridge = loadPostMessageBridge({
      installDisplayMode: (api: { requestDisplayMode: (m: string) => Promise<unknown> }) => {
        captured = api
        return { get: () => "inline", available: () => [], mountToggle: () => null }
      },
    })
    await connectWith(bridge, { availableDisplayModes: ["fullscreen"] })
    void captured?.requestDisplayMode("fullscreen")
    expect(bridge.posted.find(m => m.method === "ui/request-display-mode")?.params).toEqual({
      mode: "fullscreen",
    })
  })

  it("keeps window.McpApp.displayMode callable when the app ships its own AgentprotoUI namespace", async () => {
    // That namespace suppresses the display-mode script's injection (see
    // injectMcpAppBridge) — the API must not become undefined for it.
    const bridge = loadPostMessageBridge()
    const conn = await connectWith(bridge, { displayMode: "inline", availableDisplayModes: [] })
    const dm = conn.displayMode as {
      get: () => string
      available: () => string[]
      mountToggle: () => unknown
    }
    expect(dm.get()).toBe("inline")
    expect(dm.available()).toEqual([])
    expect(dm.mountToggle()).toBeNull()
  })
})

describe("display-mode script injection", () => {
  it("rides along with the bridge, after it and before runner-select", () => {
    const out = injectMcpAppBridge("<html><body>Panel</body></html>")
    expect(out).toContain("installDisplayMode")
    expect(out.indexOf("ui/initialize")).toBeLessThan(out.indexOf("installDisplayMode ="))
    expect(out.indexOf("installDisplayMode =")).toBeLessThan(out.indexOf("mountRunnerSelect ="))
  })

  it("ships to standalone-served apps too, so window.McpApp.displayMode is never undefined", () => {
    const out = injectStandaloneAppBridge("<html><body>Panel</body></html>")
    expect(out).toContain("installDisplayMode =")
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("installDisplayMode ="))
  })

  it("injects the installer exactly once on a repeated pass", () => {
    const once = injectMcpAppBridge("<html><body>Panel</body></html>")
    const twice = injectMcpAppBridge(once)
    expect(twice.match(/installDisplayMode = function/g)).toHaveLength(1)
    expect(twice).toBe(once)
  })

  it("stands aside for an app that defines its own window.AgentprotoUI", () => {
    const html = "<html><head><script>window.AgentprotoUI = {};</script></head><body>P</body></html>"
    expect(injectMcpAppBridge(html)).not.toContain("installDisplayMode =")
  })
})
