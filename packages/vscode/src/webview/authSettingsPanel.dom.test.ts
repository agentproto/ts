// @vitest-environment jsdom
/**
 * DOM-level coverage for the (now redirector) Auth Settings panel — drives
 * the real shipped markup/script via `buildAuthSettingsRedirectorHtml`, the
 * same pattern as the other webview dom tests. There's no daemon data here
 * anymore, just two buttons pointing at the Wallets view and the Auth &
 * Model Map.
 */
import type { DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildAuthSettingsRedirectorHtml } from "./authSettingsPanel.js"

interface Panel {
  window: DomWindow
  posted: unknown[]
}

const openWindows: DomWindow[] = []

function renderPanel(): Panel {
  const posted: unknown[] = []
  const dom = new JSDOM(buildAuthSettingsRedirectorHtml("test-nonce"), {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (msg: unknown) => posted.push(msg),
        getState: () => undefined,
        setState: () => {},
      })
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, posted }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

describe("auth settings redirector", () => {
  it("echoes the nonce and explains the split", () => {
    const html = buildAuthSettingsRedirectorHtml("NONCE123")
    expect(html).toContain('nonce="NONCE123"')
    expect(html).toContain("Wallets moved")
  })

  it("clicking 'Open Wallets' posts openWallets", () => {
    const panel = renderPanel()
    const btn = panel.window.document.getElementById("wallets")!
    btn.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
    expect(panel.posted).toEqual([{ type: "openWallets" }])
  })

  it("clicking 'Open Auth & Model Map' posts openMap", () => {
    const panel = renderPanel()
    const btn = panel.window.document.getElementById("map")!
    btn.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
    expect(panel.posted).toEqual([{ type: "openMap" }])
  })
})
