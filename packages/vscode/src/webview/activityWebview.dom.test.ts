// @vitest-environment jsdom
/**
 * DOM-level coverage for the Activity webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (the sessionsWebview.dom.test.ts idiom) so a regression in the rendered
 * markup or the click/refresh wiring fails this suite, not a hand-rolled
 * model of it.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./activityWebviewPanel.js"

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
  return found as unknown as DomElement
}

function click(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
}

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

function group(key: string, label: string, rows: unknown[]) {
  return { key, label, rows }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "turn:s1:3",
    kind: "turn",
    state: "active",
    title: "Turn 3 running on s1",
    waitingOn: undefined,
    age: "4m ago",
    stale: false,
    sessionId: "s1",
    terminal: false,
    ...overrides,
  }
}

function modelMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "model",
    connection: "connected",
    groups: [],
    shownCount: 0,
    unavailable: false,
    loadError: undefined,
    loading: false,
    ...overrides,
  }
}

describe("activity webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("activity webview — 501 degradation", () => {
  it("still paints the Terminals/Commands groups AND shows the no-projector line when unavailable", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        unavailable: true,
        groups: [
          group("terminals", "Terminals", [row({ id: "t1", kind: "terminal", title: "zsh", sessionId: "t1" })]),
          group("commands", "Commands", [row({ id: "c1", kind: "command", title: "pnpm build", sessionId: "c1" })]),
        ],
      }),
    )
    expect(el(panel, "unavailable").hidden).toBe(false)
    expect(el(panel, "unavailable").textContent).toContain("no activity projector")
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    expect(rows).toHaveLength(2)
    expect(el(panel, "list").querySelector('.ghead[data-key="terminals"]')).toBeTruthy()
    expect(el(panel, "list").querySelector('.ghead[data-key="commands"]')).toBeTruthy()
    // The shell rows stay clickable even in the degraded mode.
    expect(htmlEl(rows[0]!).getAttribute("data-clickable")).toBe("1")
  })

  it("hides the no-projector line when activities are available", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("s1", "My agent", [row()])] }))
    expect(htmlEl(el(panel, "unavailable")).hidden).toBe(true)
    const body = (panel.document as unknown as { body: DomElement }).body
    expect(htmlEl(body).className).not.toContain("daemon-state")
  })
})

describe("activity webview — render", () => {
  it("renders group headers with painted counts and their rows", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        groups: [
          group("s1", "My agent", [row()]),
          group("terminals", "Terminals", [row({ id: "t1", kind: "terminal", title: "zsh", sessionId: "t1" })]),
        ],
      }),
    )
    const heads = [...el(panel, "list").querySelectorAll(".ghead")]
    expect(heads.map(h => htmlEl(h).getAttribute("data-key"))).toEqual(["s1", "terminals"])
    expect(htmlEl(heads[0]!.querySelector(".n")).textContent).toBe("1")
    expect([...el(panel, "list").querySelectorAll(".row")]).toHaveLength(2)
  })

  it("shows a pending row's waitingOn sentence", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        groups: [
          group("s1", "My agent", [
            row({
              state: "pending",
              waitingOn: "green gate parked on policy_ack",
              terminal: false,
            }),
          ]),
        ],
      }),
    )
    const msg = el(panel, "list").querySelector('[data-id="s1"] .msg')!
    expect(msg.textContent).toBe("green gate parked on policy_ack")
    expect(el(panel, "list").querySelector('[data-id="s1"] .dot.pending')).toBeTruthy()
  })

  it("dims a terminal-state row", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("s1", "My agent", [row({ state: "done", terminal: true })])] }))
    expect(el(panel, "list").querySelector('[data-id="s1"]')!.className).toContain(" terminal")
    expect(el(panel, "list").querySelector('[data-id="s1"] .dot.done')).toBeTruthy()
  })

  it("shows the stale tell on a stale active row, without dimming it", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("s1", "My agent", [row({ stale: true })])] }))
    const staleRow = el(panel, "list").querySelector('[data-id="s1"]')!
    expect(staleRow.querySelector(".stale-flag")).toBeTruthy()
    expect(staleRow.className).not.toContain(" terminal")
    expect(staleRow.querySelector(".dot.active")).toBeTruthy()
  })

  it("renders the relative age verbatim", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("s1", "My agent", [row({ age: "12m ago" })])] }))
    expect(el(panel, "list").querySelector('[data-id="s1"] .time')!.textContent).toBe("12m ago")
  })
})

describe("activity webview — interactions", () => {
  it("clicking a terminal/command row posts open with the row's session id", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        groups: [
          group("terminals", "Terminals", [
            row({ id: "t1", kind: "terminal", title: "zsh", sessionId: "t1" }),
            row({ id: "c1", kind: "command", title: "pnpm build", sessionId: "c1" }),
            row({ id: "turn:s1:3", kind: "turn", sessionId: "s1" }),
          ]),
        ],
      }),
    )
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector('[data-id="t1"]')!)
    expect(panel.posted).toEqual([{ type: "open", id: "t1" }])
    // An activity row (kind turn) is NOT clickable — read-only.
    click(panel, el(panel, "list").querySelector('[data-id="s1"]')!)
    expect(panel.posted).toEqual([{ type: "open", id: "t1" }])
  })

  it("clicking the refresh control posts refresh", () => {
    const panel = renderPanel()
    panel.posted.length = 0
    click(panel, el(panel, "refresh"))
    expect(panel.posted).toEqual([{ type: "refresh" }])
  })

  it("collapsing a group header hides its rows without posting anything", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("s1", "My agent", [row()])] }))
    panel.posted.length = 0
    const head = el(panel, "list").querySelector('.ghead[data-key="s1"]')!
    const body = el(panel, "list").querySelector('.gbody[data-body="s1"]')!
    expect(htmlEl(body).hidden).toBe(false)
    click(panel, head)
    expect(htmlEl(body).hidden).toBe(true)
    expect(head.className).toContain("closed")
    expect(panel.posted).toEqual([])
  })
})
