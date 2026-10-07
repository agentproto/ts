// @vitest-environment jsdom
/**
 * Real-DOM coverage for the daemon's "building"/"error" stand-in pages
 * (`@agentproto/runtime/app-ui-placeholder`) — the html an app panel shows
 * in place of its real UI while `ui.build` runs, or when it can never be
 * served. It's served as the SAME `ui://app_ui_<id>/view` resource a real
 * app panel is (app-ui-apps.ts), so it lands in the VS Code webview's inner
 * `srcdoc` iframe — buildAppHostHtml's outer document sets `default-src
 * 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'` with NO
 * `connect-src`, and the srcdoc iframe inherits that verbatim. jsdom
 * doesn't enforce CSP from a meta tag, so this asserts the CSP-relevant
 * PROPERTIES directly: nothing here opens a network client (no `fetch`,
 * `XMLHttpRequest`, `WebSocket`, `EventSource`, or externally-sourced
 * `<script>`/`<img>`/`<link>`), and the one bit of inline script it does
 * ship — the elapsed-time counter plus an HTTP-only reload timer — runs
 * safely in `about:srcdoc` (where the reload branch stays off) and mutates the DOM
 * under `runScripts: "dangerously"` with no other globals stubbed in
 * (exactly what an `unsafe-inline`, `connect-src`-less document allows).
 */
import type { DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { renderAppUiBuildingHtml, renderAppUiErrorHtml } from "@agentproto/runtime/app-ui-placeholder"

const openWindows: DomWindow[] = []

function render(html: string): DomWindow {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/" })
  openWindows.push(dom.window)
  return dom.window
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

/** Grep the raw markup for anything that would need a CSP `connect-src` or
 *  an allowed external origin — neither is granted under the webview's CSP. */
function assertNoNetworkSurface(html: string): void {
  expect(html).not.toMatch(/\bfetch\s*\(/)
  expect(html).not.toMatch(/XMLHttpRequest/)
  expect(html).not.toMatch(/new\s+WebSocket/)
  expect(html).not.toMatch(/new\s+EventSource/)
  expect(html).not.toMatch(/<script[^>]+\bsrc=/i)
  expect(html).not.toMatch(/<img[^>]+\bsrc=(?!["']data:)/i)
  expect(html).not.toMatch(/<link[^>]/i)
}

describe("renderAppUiBuildingHtml under the VS Code webview CSP", () => {
  it("carries no network surface at all", () => {
    assertNoNetworkSurface(renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() }))
  })

  it("runs its inline script and ticks the elapsed counter with no globals beyond a bare DOM", async () => {
    const startedAt = Date.now() - 5_000
    const window = render(renderAppUiBuildingHtml({ appName: "Model Bench", startedAt }))
    const el = () => window.document.getElementById("agentproto-elapsed")
    // The script runs synchronously on parse — already past "elapsed 0s".
    expect(el()?.textContent).toMatch(/^elapsed \d+s$/)
    expect(el()?.textContent).toBe("elapsed 5s")
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(el()?.textContent).toBe("elapsed 6s")
  })

  it("shows the app name and, when given one, the build log tail", () => {
    const window = render(
      renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now(), logTail: "vite building...\n42%" }),
    )
    expect(window.document.body.textContent).toContain("Model Bench")
    expect(window.document.body.textContent).toContain("vite building")
  })

  it("carries the building status marker appPanel.logic.ts polls on", () => {
    const html = renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() })
    expect(html).toContain('data-agentproto-ui-status="building"')
  })

  it("keeps meta refresh as the no-script fallback without adding a fetch surface", () => {
    const window = render(renderAppUiBuildingHtml({ appName: "Model Bench", startedAt: Date.now() }))
    const meta = window.document.querySelector('meta[http-equiv="refresh"]')
    expect(meta?.getAttribute("content")).toMatch(/^\d+$/)
  })
})

describe("renderAppUiErrorHtml under the VS Code webview CSP", () => {
  it("carries no network surface at all", () => {
    assertNoNetworkSurface(
      renderAppUiErrorHtml({ appName: "Model Bench", message: "ui bundle is missing", detailPath: "/tmp/x/index.html" }),
    )
  })

  it("never auto-refreshes — a failed build must not be retried on a timer", () => {
    const window = render(renderAppUiErrorHtml({ appName: "Model Bench", message: "boom" }))
    expect(window.document.querySelector('meta[http-equiv="refresh"]')).toBeNull()
  })

  it("carries no building-status marker", () => {
    const html = renderAppUiErrorHtml({ appName: "Model Bench", message: "boom" })
    expect(html).not.toContain('data-agentproto-ui-status="building"')
  })

  it("renders the message, the detail path, and a log tail as visible text, never as raw JSON", () => {
    const window = render(
      renderAppUiErrorHtml({
        appName: "Model Bench",
        message: 'could not read app "@agentik/model-bench"\'s ui html',
        detailPath: "/Users/x/apps/model-bench/.agentproto/ui/index.html",
        logTail: "Error: ENOENT: no such file or directory",
      }),
    )
    const text = window.document.body.textContent ?? ""
    expect(text).toContain("could not read app")
    expect(text).toContain("index.html")
    expect(text).toContain("ENOENT")
    expect(text.trim().startsWith("{")).toBe(false)
  })
})
