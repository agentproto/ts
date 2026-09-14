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
    // The app html referencing window.McpApp must NOT suppress injection
    // (unlike injectMcpAppBridge's idempotence check) — every bundled UI
    // calls window.McpApp.connect(), and standalone serving still needs
    // the bridge defined first.
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("window.McpApp.connect()"))
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
    expect(out).toContain("AgentprotoUI")
    expect(out.indexOf('fetch("./tool-call"')).toBeLessThan(out.indexOf("AgentprotoUI"))
  })

  it("does not re-inject the runner-select script on a second pass", () => {
    const html = "<html><body>Panel</body></html>"
    const once = injectStandaloneAppBridge(html)
    const twice = injectStandaloneAppBridge(once)
    expect(twice.match(/window\.AgentprotoUI\s*=/g)?.length).toBe(1)
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
