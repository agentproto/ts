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
import {
  appUiToolId,
  createUiHtmlCache,
  injectMcpAppBridge,
  injectStandaloneAppBridge,
  makeInstalledAppUiApps,
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
