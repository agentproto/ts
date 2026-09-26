/**
 * Real-DOM coverage for `@agentproto/config`'s MCP-hosted deep-link routing
 * (plan §3.4, PR-5): an MCP host has no URL bar for this panel, so it opens
 * `app_ui_config { view }` instead of relying on `location.hash` directly.
 * `ui.ts` surfaces that via the bridge's `onToolInput(cb)` and turns it into
 * the same `#<section>[/<id>[/<sub>]]` fragment a browser deep link would
 * produce — see `routeToView`/`handleToolInput`/`shouldApplyIncomingView`
 * there.
 *
 * Same harness pattern as config-edit.test.ts: the REAL panel script run
 * through jsdom against a fake `window.McpApp` bridge, rather than a
 * hand-modeled re-implementation of the routing logic. The fake `callTool`
 * never inspects the tool name — every card renders its own empty state,
 * which is fine, since this suite is about which SECTION becomes active and
 * what `location.hash` ends up as, not section content.
 */
import type { DomMcpAppToolInput, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { CONFIG_HTML } from "../config/ui.js"

interface Panel {
  window: DomWindow
  onToolInputCbs: Array<(input: DomMcpAppToolInput) => void>
}

const openWindows: DomWindow[] = []

function renderPanel(url: string): Panel {
  const onToolInputCbs: Array<(input: DomMcpAppToolInput) => void> = []
  const dom = new JSDOM(CONFIG_HTML, {
    runScripts: "dangerously",
    url,
    beforeParse(window) {
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: () => Promise.resolve({ content: [{ type: "text", text: "{}" }] }),
            updateModelContext: () => Promise.resolve(),
            onTeardown: () => {},
            onToolInput: cb => {
              onToolInputCbs.push(cb)
            },
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, onToolInputCbs }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

/** Lets the connect().then(...) promise chain and any hashchange-driven
 *  re-route drain past a real jsdom boot. */
async function settle(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function activeSection(window: DomWindow): string | null {
  const active = window.document.querySelectorAll(".section.active")
  return active.length > 0 ? active[0]!.getAttribute("data-section") : null
}

describe("@agentproto/config panel: MCP-hosted view routing", () => {
  it("routes to the tool-input view when no browser hash is present at load", async () => {
    const panel = renderPanel("https://example.test/")
    await settle()
    expect(activeSection(panel.window)).toBe("wallets")
    expect(panel.onToolInputCbs).toHaveLength(1)

    panel.onToolInputCbs[0]!({ view: "harnesses" })
    await settle()

    expect(activeSection(panel.window)).toBe("harnesses")
    expect(panel.window.location.hash).toBe("#harnesses")
  })

  it("accepts a view with a leading '#', matching the browser fragment grammar", async () => {
    const panel = renderPanel("https://example.test/")
    await settle()

    panel.onToolInputCbs[0]!({ view: "#models" })
    await settle()

    expect(activeSection(panel.window)).toBe("models")
    expect(panel.window.location.hash).toBe("#models")
  })

  it("lets an existing browser hash win over the first tool-input view", async () => {
    const panel = renderPanel("https://example.test/#models")
    await settle()
    expect(activeSection(panel.window)).toBe("models")

    panel.onToolInputCbs[0]!({ view: "harnesses" })
    await settle()

    expect(activeSection(panel.window)).toBe("models")
    expect(panel.window.location.hash).toBe("#models")
  })

  it("re-routes on a later tool-input update even after the browser hash won the first one", async () => {
    const panel = renderPanel("https://example.test/#models")
    await settle()
    panel.onToolInputCbs[0]!({ view: "harnesses" }) // 1st arrival: ignored, hash wins
    await settle()
    expect(activeSection(panel.window)).toBe("models")

    panel.onToolInputCbs[0]!({ view: "remote" }) // 2nd arrival: a live "go to this view" command
    await settle()

    expect(activeSection(panel.window)).toBe("remote")
    expect(panel.window.location.hash).toBe("#remote")
  })

  it("ignores a tool-input notification carrying no view", async () => {
    const panel = renderPanel("https://example.test/")
    await settle()

    panel.onToolInputCbs[0]!({})
    await settle()

    expect(activeSection(panel.window)).toBe("wallets")
    expect(panel.window.location.hash).toBe("#wallets")
  })
})
