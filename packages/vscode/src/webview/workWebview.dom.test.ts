// @vitest-environment jsdom
/**
 * DOM-level coverage for the Work webview panel's shipped script — extracts
 * and executes the REAL HTML/script via the exported `buildHtml` (mirrors
 * sessionsWebview.dom.test.ts's pattern) so a regression in the rendered
 * markup or the click wiring fails this suite, not a hand-rolled model of it.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./workWebviewPanel.js"

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

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

function group(key: string, label: string, rows: unknown[]) {
  return { key, label, rows }
}

function row(overrides: Record<string, unknown> & { taskId: string }) {
  return {
    boardId: "ws:ws",
    title: `Task ${overrides.taskId}`,
    owner: undefined,
    status: "pending",
    cancelled: false,
    tell: "",
    age: "2m ago",
    ...overrides,
  }
}

function modelMessage(
  overrides: {
    groups?: unknown[]
    connection?: unknown
    unavailable?: boolean
    loadError?: string
    loading?: boolean
  } = {},
) {
  return {
    type: "model",
    connection: overrides.connection,
    groups: overrides.groups ?? [],
    shownCount: 0,
    unavailable: overrides.unavailable ?? false,
    loadError: overrides.loadError,
    loading: false,
  }
}

describe("work webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })

  it("ships a connecting state before the daemon replies", () => {
    const panel = renderPanel()
    expect((panel.document as DomDocument & { body: DomElement }).body.className).toContain("daemon-state")
    expect(el(panel, "daemon-state").textContent).toContain("Connecting to agentproto daemon")
  })
})

describe("work webview — render", () => {
  it("renders the four status groups in the fixed order, with cancelled folded into Failed", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        connection: "connected",
        groups: [
          group("unclaimed", "Unclaimed", [row({ taskId: "t3", status: "pending" })]),
          group("in_progress", "In progress", [row({ taskId: "t2", status: "in_progress", owner: "sess_a" })]),
          group("done", "Done", [row({ taskId: "t1", status: "done" })]),
          group("failed", "Failed", [
            row({ taskId: "c1", status: "cancelled", cancelled: true }),
            row({ taskId: "f1", status: "failed" }),
          ]),
        ],
      }),
    )
    const heads = [...el(panel, "list").querySelectorAll(".ghead")]
    expect(heads.map(h => htmlEl(h).getAttribute("data-key"))).toEqual([
      "unclaimed",
      "in_progress",
      "done",
      "failed",
    ])
    expect(heads.map(h => htmlEl(h).textContent)).toMatchObject([
      expect.stringContaining("Unclaimed"),
      expect.stringContaining("In progress"),
      expect.stringContaining("Done"),
      expect.stringContaining("Failed"),
    ])
    const failedBody = el(panel, "list").querySelector('.gbody[data-body="failed"]')!
    expect([...failedBody.querySelectorAll(".row")]).toHaveLength(2)
    // The cancelled task renders inside Failed, tagged distinctly — a fifth
    // column never appears.
    expect(failedBody.querySelector(".tag.cancelled")!.textContent).toBe("cancelled")
    expect(el(panel, "list").innerHTML).not.toContain("Pending")
  })

  it("renders the verification tell honestly — a declared verify with nothing verified is NOT a green check", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        connection: "connected",
        groups: [
          group("in_progress", "In progress", [
            // Declared verify, nothing verified yet — the grey "gated" tag.
            row({ taskId: "g1", status: "in_progress", owner: "sess_a", tell: "gated" }),
          ]),
          group("done", "Done", [
            // Gate-passed — the solid green check.
            row({ taskId: "d1", status: "done", tell: "✓ gate" }),
            // Self-report and human stay visually distinct from the gate check.
            row({ taskId: "d2", status: "done", tell: "self-report" }),
            row({ taskId: "d3", status: "done", tell: "human" }),
          ]),
        ],
      }),
    )
    const list = el(panel, "list")
    const gated = list.querySelector('[data-body="in_progress"] .tag.gated')!
    expect(gated.textContent).toBe("gated")
    expect(gated.className).not.toContain("gate ")
    expect(gated.className).not.toBe("tag gate")
    expect(list.querySelector(".tag.gate")!.textContent).toBe("✓ gate")
    // Self-report and human stay visually distinct from the gate check too.
    expect(list.querySelector(".tag.self")!.textContent).toBe("self-report")
    expect(list.querySelector(".tag.human")!.textContent).toBe("human")
  })

  it("marks a cancelled task's title struck-through and renders owner vs Unclaimed", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({
        connection: "connected",
        groups: [
          group("unclaimed", "Unclaimed", [row({ taskId: "u1" })]),
          group("failed", "Failed", [row({ taskId: "c1", status: "cancelled", cancelled: true, owner: "sess_b" })]),
        ],
      }),
    )
    expect(el(panel, "list").querySelector('[data-body="unclaimed"] .sub')!.textContent).toBe("Unclaimed")
    expect(el(panel, "list").querySelector('[data-body="failed"] .sub')!.textContent).toBe("claimed by sess_b")
    expect(el(panel, "list").querySelector('[data-body="failed"] .row')!.className).toContain("cancelled")
  })
})

describe("work webview — degradation", () => {
  it("shows the one quiet line instead of a blank view when the daemon has no task ledger", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "connected", unavailable: true, groups: [] }))
    expect(el(panel, "unavailable").hidden).toBe(false)
    expect(el(panel, "unavailable").textContent).toContain("no task ledger wired")
    // The view is not blank: the Open-the-board affordance is still there.
    expect(el(panel, "board-btn").hidden).toBe(false)
    expect(el(panel, "list").querySelectorAll(".row")).toHaveLength(0)
  })

  it("hides the degradation line when tasks load", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "connected", unavailable: true }))
    send(panel, modelMessage({ connection: "connected", unavailable: false }))
    expect(htmlEl(el(panel, "unavailable")).hidden).toBe(true)
  })

  it("shows a load error when the failure is not the 501 degradation", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "connected", loadError: "daemon unreachable" }))
    expect(el(panel, "error").hidden).toBe(false)
    expect(el(panel, "error").textContent).toBe("daemon unreachable")
  })

  it("replaces the list with the connecting state when the daemon is unreachable", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "unreachable" }))
    expect((panel.document as DomDocument & { body: DomElement }).body.className).toContain("daemon-state")
  })
})

describe("work webview — interactions", () => {
  it("clicking Open the board posts the message that triggers agentproto.openWorkBoard", () => {
    const panel = renderPanel()
    panel.posted.length = 0
    click(panel, el(panel, "board-btn"))
    expect(panel.posted).toEqual([{ type: "openBoard" }])
  })

  it("clicking a group header collapses and re-expands its rows", () => {
    const panel = renderPanel()
    send(
      panel,
      modelMessage({ connection: "connected", groups: [group("unclaimed", "Unclaimed", [row({ taskId: "u1" })])] }),
    )
    const head = el(panel, "list").querySelector('.ghead[data-key="unclaimed"]')!
    const body = el(panel, "list").querySelector('.gbody[data-body="unclaimed"]')!
    expect(htmlEl(body).hidden).toBe(false)
    click(panel, head)
    expect(htmlEl(body).hidden).toBe(true)
    expect(head.className).toContain("closed")
    click(panel, head)
    expect(htmlEl(body).hidden).toBe(false)
    // Collapsing is purely local — no message posted for it.
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})
