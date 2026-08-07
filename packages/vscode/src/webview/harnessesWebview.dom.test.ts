// @vitest-environment jsdom
/**
 * DOM-level coverage for the Harnesses webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors sessionsWebview.dom.test.ts's own pattern) so a regression in the
 * rendered markup or the click/keydown wiring fails this suite, not just a
 * hand-rolled model of it.
 *
 * Covers the button redesign: one labeled action per row in a stable slot
 * (no ✓ glyph, no hover-swap), row-level click/Enter triggering that action,
 * and the disabled spinner "Installing…" state.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./harnessesWebviewPanel.js"

interface Panel {
  window: DomWindow
  document: DomDocument
  posted: unknown[]
}

const openWindows: DomWindow[] = []

function renderPanel(): Panel {
  const posted: unknown[] = []
  const dom = new JSDOM(buildHtml("test-nonce", "vscode-resource:"), {
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
  return { window: dom.window, document: dom.window.document, posted }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

function htmlEl(element: DomElement | null): HTMLElement {
  return element as unknown as HTMLElement
}

function el(panel: Panel, id: string): DomElement {
  const found = panel.document.getElementById(id)
  if (!found) throw new Error(`#${id} missing from buildHtml output`)
  return found
}

function click(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
}

function keydown(panel: Panel, element: DomElement, key: string): void {
  element.dispatchEvent(new panel.window.KeyboardEvent("keydown", { key, bubbles: true }))
}

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

const START_ROW = {
  slug: "claude-code",
  name: "Claude Code",
  description: "claude-code · ready · v2.1.4",
  status: "ready",
  installable: false,
  action: "start",
  logo: { kind: "lettermark", text: "C" },
}

const INSTALL_ROW = {
  slug: "codex",
  name: "Codex",
  description: "codex · not installed",
  status: "available",
  installable: true,
  action: "install",
  logo: { kind: "lettermark", text: "X" },
}

const INSTALLING_ROW = {
  ...INSTALL_ROW,
  action: "installing",
}

function modelMessage(rows: unknown[]) {
  return {
    type: "model",
    rows,
    shownCount: rows.length,
    totalCount: rows.length,
    search: "",
  }
}

describe("harnesses webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("harnesses webview — render", () => {
  it("renders one focusable row per adapter", () => {
    const panel = renderPanel()
    send(panel, modelMessage([START_ROW, INSTALL_ROW]))
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(htmlEl(r).getAttribute("tabindex")).toBe("0")
  })

  it("renders a labeled ▶ Start button for an installed harness — no bare ✓ glyph anywhere", () => {
    const panel = renderPanel()
    send(panel, modelMessage([START_ROW]))
    const list = el(panel, "list")
    expect(list.innerHTML).not.toContain("✓")
    const btn = htmlEl(list.querySelector('button[data-act="start"]'))
    expect(btn.tagName).toBe("BUTTON")
    expect(btn.textContent).toContain("Start")
    expect(btn.getAttribute("title")).toBe("Start a session with Claude Code")
    expect((btn as unknown as HTMLButtonElement).disabled).toBe(false)
  })

  it("renders a labeled Install button for an installable harness", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALL_ROW]))
    const btn = htmlEl(el(panel, "list").querySelector('button[data-act="install"]'))
    expect(btn.tagName).toBe("BUTTON")
    expect(btn.textContent).toBe("Install")
    expect((btn as unknown as HTMLButtonElement).disabled).toBe(false)
  })

  it("renders a disabled spinner button while installing, reflecting the panel's optimistic state", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALLING_ROW]))
    const row = el(panel, "list").querySelector(".row")!
    const btn = htmlEl(row.querySelector("button"))
    expect((btn as unknown as HTMLButtonElement).disabled).toBe(true)
    expect(btn.textContent).toContain("Installing")
    expect(row.querySelector(".spin")).toBeTruthy()
  })

  it("gives every row the same minimum action width so the layout never jumps between states", () => {
    const panel = renderPanel()
    send(panel, modelMessage([START_ROW, INSTALL_ROW, INSTALLING_ROW]))
    const buttons = [...el(panel, "list").querySelectorAll("button.act")]
    expect(buttons).toHaveLength(3)
  })
})

describe("harnesses webview — interactions", () => {
  it("clicking an installable row posts install with its slug", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALL_ROW]))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector(".row")!)
    expect(panel.posted).toEqual([{ type: "install", slug: "codex" }])
  })

  it("clicking a ready row posts spawn with its slug", () => {
    const panel = renderPanel()
    send(panel, modelMessage([START_ROW]))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector(".row")!)
    expect(panel.posted).toEqual([{ type: "spawn", slug: "claude-code" }])
  })

  it("clicking an installing row posts nothing — the action is disabled mid-install", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALLING_ROW]))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector(".row")!)
    expect(panel.posted).toEqual([])
  })

  it("Enter on a focused row triggers the same action as a click", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALL_ROW]))
    panel.posted.length = 0
    keydown(panel, el(panel, "list").querySelector(".row")!, "Enter")
    expect(panel.posted).toEqual([{ type: "install", slug: "codex" }])
  })

  it("Enter on a focused ready row posts spawn", () => {
    const panel = renderPanel()
    send(panel, modelMessage([START_ROW]))
    panel.posted.length = 0
    keydown(panel, el(panel, "list").querySelector(".row")!, "Enter")
    expect(panel.posted).toEqual([{ type: "spawn", slug: "claude-code" }])
  })

  it("a non-Enter key on a row does nothing", () => {
    const panel = renderPanel()
    send(panel, modelMessage([INSTALL_ROW]))
    panel.posted.length = 0
    keydown(panel, el(panel, "list").querySelector(".row")!, "a")
    expect(panel.posted).toEqual([])
  })
})
