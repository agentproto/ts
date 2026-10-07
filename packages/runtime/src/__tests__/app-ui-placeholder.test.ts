/**
 * Unit coverage for app-ui-placeholder.ts — the building/error stand-in
 * pages served in place of an installed app's real UI. See the jsdom CSP
 * coverage in packages/vscode's appUiPlaceholder.dom.test.ts for the
 * "actually runs under the webview's CSP" half of this; this file covers
 * the markup/escaping/marker contract these two hosts (app-ui-apps.ts's
 * `ui://` resource, http-server.ts's `GET /apps/:appId/ui`) both rely on.
 */

import { describe, expect, it } from "vitest"
import {
  APP_UI_BUILDING_STATUS_ATTR,
  renderAppUiBuildingHtml,
  renderAppUiErrorHtml,
} from "../app-ui-placeholder.js"

describe("renderAppUiBuildingHtml", () => {
  it("carries the building status marker", () => {
    const html = renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() })
    expect(html).toContain(APP_UI_BUILDING_STATUS_ATTR)
  })

  it("includes a meta refresh so the standalone HTTP page re-navigates on its own", () => {
    const html = renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() })
    expect(html).toMatch(/<meta http-equiv="refresh" content="\d+">/)
  })

  it("actively reloads an HTTP host when embedded browsers ignore meta refresh", () => {
    const html = renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() })
    expect(html).toContain('window.location.protocol === "http:"')
    expect(html).toContain("window.location.reload()")
  })

  it("escapes the app name (no markup injection via a hostile install)", () => {
    const html = renderAppUiBuildingHtml({ appName: '<script>alert(1)</script>', startedAt: Date.now() })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("bakes in startedAt as a JS number literal, not a string, for the client-side elapsed timer", () => {
    const startedAt = 1_700_000_000_000
    const html = renderAppUiBuildingHtml({ appName: "App", startedAt })
    expect(html).toContain(`var startedAt = ${startedAt};`)
  })

  it("includes the log tail when given one, escaped", () => {
    const html = renderAppUiBuildingHtml({
      appName: "App",
      startedAt: Date.now(),
      logTail: "building <module>...",
    })
    expect(html).toContain("building &lt;module&gt;...")
  })

  it("omits the <pre> block entirely when no log tail is given", () => {
    const html = renderAppUiBuildingHtml({ appName: "App", startedAt: Date.now() })
    expect(html).not.toContain("<pre>")
  })
})

describe("renderAppUiErrorHtml", () => {
  it("carries no building status marker and no meta refresh", () => {
    const html = renderAppUiErrorHtml({ appName: "Model Bench", message: "boom" })
    expect(html).not.toContain(APP_UI_BUILDING_STATUS_ATTR)
    expect(html).not.toMatch(/<meta http-equiv="refresh"/)
  })

  it("never emits the message as raw JSON — the bug this replaces", () => {
    const html = renderAppUiErrorHtml({
      appName: "@agentik/model-bench",
      message: 'could not read app "@agentik/model-bench"\'s ui html at "/x/index.html": ENOENT',
      detailPath: "/x/index.html",
    })
    // The literal `{"error":...}` shape that used to be the page body.
    expect(html.trimStart().startsWith("{")).toBe(false)
    expect(html).not.toMatch(/^\s*\{"error"/)
    expect(html).toContain("could not read app")
    expect(html).toContain("ENOENT")
  })

  it("shows the detail path and a default fix hint when none is given", () => {
    const html = renderAppUiErrorHtml({
      appName: "App",
      message: "missing bundle",
      detailPath: "/apps/x/.agentproto/ui/index.html",
    })
    expect(html).toContain("/apps/x/.agentproto/ui/index.html")
    expect(html).toContain("app_install")
  })

  it("uses a caller-supplied fix hint verbatim when given", () => {
    const html = renderAppUiErrorHtml({
      appName: "App",
      message: "dir gone",
      fix: "Remove the stale install.",
    })
    expect(html).toContain("Remove the stale install.")
    expect(html).not.toContain("app_install")
  })

  it("escapes a hostile message/appName", () => {
    const html = renderAppUiErrorHtml({
      appName: "App",
      message: '<img src=x onerror=alert(1)>',
    })
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).toContain("&lt;img")
  })
})
