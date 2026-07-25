// @vitest-environment jsdom
/**
 * DOM-level coverage for the Sessions webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors transcriptPanel.dom.test.ts's own pattern) so a regression in the
 * rendered markup or the click/filter/tab wiring fails this suite, not just
 * a hand-rolled model of it.
 */
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./sessionsWebviewPanel.js"
import type { DomWindow, DomDocument, DomElement } from "jsdom"

interface Panel {
  window: DomWindow
  document: DomDocument
  posted: unknown[]
}

const openWindows: DomWindow[] = []

function renderPanel(): Panel {
  const posted: unknown[] = []
  const dom = new JSDOM(buildHtml("test-nonce"), {
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

function el(panel: Panel, id: string): DomElement {
  const found = panel.document.getElementById(id)
  if (!found) throw new Error(`#${id} missing from buildHtml output`)
  return found
}

function click(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
}

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

const ROW_A = {
  id: "s1",
  isSub: false,
  open: false,
  status: "live",
  name: "openagentik-migration-lead",
  message: "Fanned out 3 executors.",
  tag: "in-place",
  harnessGlyph: "✳",
  model: "opus",
  ctxPercent: 71,
  cost: "$1.24",
  time: "now",
}

const ROW_CHILD = {
  ...ROW_A,
  id: "s1-child",
  isSub: true,
  name: "exec · canvakit-extract",
  harnessGlyph: "☿",
  model: "glm-5.2",
  cost: undefined,
}

function modelMessage(overrides: { recent?: unknown[]; older?: unknown[]; summary?: string } = {}) {
  return {
    type: "model",
    summary: overrides.summary ?? "2 loaded",
    groups: [
      {
        id: "workspace-group:studio",
        name: "Main monorepo",
        count: 2,
        recent: overrides.recent ?? [ROW_A, ROW_CHILD],
        older: overrides.older ?? [],
      },
    ],
  }
}

describe("sessions webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("sessions webview — render", () => {
  it("renders a group header with its count badge, and recent rows", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const list = el(panel, "list")
    expect(list.innerHTML).toContain("Main monorepo")
    expect(list.innerHTML).toContain("2")
    expect(list.innerHTML).toContain("openagentik-migration-lead")
    expect(list.querySelectorAll(".row")).toBeTruthy()
  })

  it("marks a subagent row .sub (indentation/dimming) and a root row not", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    const root = rows.find(r => r.dataset["id"] === "s1")
    const child = rows.find(r => r.dataset["id"] === "s1-child")
    expect(root?.className).not.toContain(" sub")
    expect(child?.className).toContain(" sub")
  })

  it("marks the row whose transcript tab is open with .open — an accent bar, not a click-selection", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [{ ...ROW_A, open: true }, ROW_CHILD] }))
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    const openRow = rows.find(r => r.dataset["id"] === "s1")
    expect(openRow?.className).toContain(" open")
  })

  it("renders the recency divider only when an older section is non-empty", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [ROW_A], older: [ROW_CHILD] }))
    expect(el(panel, "list").innerHTML).toContain("Older than 24 hours")
  })

  it("shows the empty state when every group has zero rows, hides it otherwise", () => {
    const panel = renderPanel()
    expect(el(panel, "empty").hidden).toBe(true) // initial markup ships hidden
    send(panel, {
      type: "model",
      summary: "0 loaded",
      groups: [{ id: "g", name: "Main monorepo", count: 0, recent: [], older: [] }],
    })
    expect(el(panel, "empty").hidden).toBe(false)
    send(panel, modelMessage())
    expect(el(panel, "empty").hidden).toBe(true)
  })

  it("writes the host-computed summary line verbatim", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ summary: "3 of 20 shown" }))
    expect(el(panel, "summary").textContent).toBe("3 of 20 shown")
  })
})

describe("sessions webview — interactions", () => {
  it("clicking a row posts open with that row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const row = [...el(panel, "list").querySelectorAll(".row")].find(r => r.dataset["id"] === "s1")!
    click(panel, row)
    expect(panel.posted).toEqual([{ type: "open", id: "s1" }])
  })

  it("the hover ↗ affordance posts the same open message as a row click", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const openBtn = el(panel, "list").querySelector('[data-open="s1-child"]')!
    click(panel, openBtn)
    expect(panel.posted).toEqual([{ type: "open", id: "s1-child" }])
  })

  it("clicking a status tab marks it active and posts the tab id", () => {
    const panel = renderPanel()
    const liveTab = el(panel, "tabs").querySelector('[data-tab="live"]')!
    click(panel, liveTab)
    expect(liveTab.className).toContain("on")
    expect(el(panel, "tabs").querySelector('[data-tab="all"]')!.className).not.toContain("on")
    expect(panel.posted.at(-1)).toEqual({ type: "tab", tab: "live" })
  })

  it("typing in the pinned filter posts a filter message with the trimmed text", async () => {
    const panel = renderPanel()
    const q = el(panel, "q")
    q.value = "  sales  "
    q.dispatchEvent(new panel.window.Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(panel.posted.at(-1)).toEqual({ type: "filter", search: "sales" })
    expect(el(panel, "clear").className).toContain("show")
  })

  it("the clear button empties the input and posts an empty filter", async () => {
    const panel = renderPanel()
    const q = el(panel, "q")
    q.value = "sales"
    q.dispatchEvent(new panel.window.Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 200))
    click(panel, el(panel, "clear"))
    expect(q.value).toBe("")
    expect(panel.posted.at(-1)).toEqual({ type: "filter", search: "" })
    expect(el(panel, "clear").className).not.toContain("show")
  })
})
