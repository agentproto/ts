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
import { appUiToolId, createUiHtmlCache, makeInstalledAppUiApps } from "../app-ui-apps.js"
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
    expect(apps[0]!.html).toBe("<html><body>Panel</body></html>")
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

  it("caches HTML by (path, version) and re-reads only on a version change", async () => {
    const uiPath = join(dir, "index.html")
    await writeFile(uiPath, "v1", "utf8")

    const cache = createUiHtmlCache()
    expect(await cache.get(uiPath, "2026-01-01T00:00:00.000Z")).toBe("v1")

    await writeFile(uiPath, "v2", "utf8")
    // Same version — still cached, doesn't pick up the on-disk change.
    expect(await cache.get(uiPath, "2026-01-01T00:00:00.000Z")).toBe("v1")
    // New version — re-reads.
    expect(await cache.get(uiPath, "2026-01-02T00:00:00.000Z")).toBe("v2")
  })
})
