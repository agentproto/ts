// @vitest-environment jsdom
/**
 * DOM-level coverage for the Sessions webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors transcriptPanel.dom.test.ts's own pattern) so a regression in the
 * rendered markup or the click/filter/tab/workspace wiring fails this suite,
 * not just a hand-rolled model of it.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./sessionsWebviewPanel.js"

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

function change(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("change", { bubbles: true }))
}

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

const ROW_A = {
  id: "s1",
  isSub: false,
  open: false,
  status: "working",
  name: "openagentik-migration-lead",
  message: "Fanned out 3 executors.",
  tag: "in-place",
  harnessGlyph: "✳",
  model: "opus",
  ctxPercent: 71,
  cost: "$1.24",
  time: "now",
  unread: false,
  action: "stop",
  workspace: { slug: "studio", label: "Agentik Studio", colorIndex: 0, css: "#c45c26" },
  archived: false,
}

const ROW_CHILD = {
  ...ROW_A,
  id: "s1-child",
  isSub: true,
  name: "exec · canvakit-extract",
  harnessGlyph: "☿",
  model: "glm-5.2",
  cost: undefined,
  ctxPercent: undefined,
  action: undefined,
}

const ROW_DONE = {
  id: "s2",
  isSub: false,
  open: false,
  status: "done",
  name: "sales-analysis",
  message: undefined,
  tag: "in-place",
  harnessGlyph: "✳",
  model: undefined,
  ctxPercent: undefined,
  cost: undefined,
  time: "2h ago",
  unread: false,
  action: "archive",
  workspace: undefined,
  archived: false,
}

function modelMessage(
  overrides: {
    recent?: unknown[]
    older?: unknown[]
    summary?: string
    workspaces?: unknown[]
    selectedWorkspace?: string
    connection?: unknown
  } = {},
) {
  return {
    type: "model",
    connection: overrides.connection,
    summary: overrides.summary ?? "2 loaded",
    section: {
      recent: overrides.recent ?? [ROW_A, ROW_CHILD],
      older: overrides.older ?? [],
    },
    workspaces: overrides.workspaces ?? [{ slug: "studio", label: "Agentik Studio", colorIndex: 0, css: "#c45c26" }],
    selectedWorkspace: overrides.selectedWorkspace ?? "__all__",
  }
}

describe("sessions webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })

  it("ships a full-height connecting state before the daemon replies", () => {
    const panel = renderPanel()
    expect(el(panel, "daemon-state").dataset["state"]).toBe("connecting")
    expect(el(panel, "daemon-title").textContent).toContain("Connecting to agentproto daemon")
  })
})

describe("sessions webview — daemon connection state", () => {
  it("replaces the list with an actionable setup screen when the daemon is unreachable", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "unreachable" }))

    expect(el(panel, "daemon-title").textContent).toContain("is not running")
    expect(el(panel, "daemon-description").textContent).toContain("keep trying")
    expect(el(panel, "daemon-state").textContent).toContain("agentproto serve")

    click(panel, el(panel, "daemon-state").querySelector("[data-refresh]")!)
    click(panel, el(panel, "daemon-state").querySelector("[data-docs]")!)
    click(panel, el(panel, "daemon-state").querySelector("[data-copy-claude]")!)
    expect(panel.posted).toEqual([
      { type: "ready" },
      { type: "refresh" },
      { type: "openDocs" },
      { type: "copyClaudePrompt" },
    ])
  })

  it("restores the normal session UI as soon as the daemon connects", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ connection: "connected" }))

    expect([...el(panel, "list").querySelectorAll(".row")]).toHaveLength(2)
  })
})

describe("sessions webview — render", () => {
  it("renders recent rows in a single continuous list", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const list = el(panel, "list")
    expect(list.innerHTML).toContain("openagentik-migration-lead")
    expect(list.innerHTML).toContain("exec · canvakit-extract")
    expect([...list.querySelectorAll(".row")].length).toBe(2)
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

  it("marks the row whose transcript tab is open with .open — a static accent bar, not a pulsing dot", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [{ ...ROW_A, open: true }, ROW_CHILD] }))
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    const openRow = rows.find(r => r.dataset["id"] === "s1")
    expect(openRow?.className).toContain(" open")
    // The open indicator is the left bar; the working dot is independent.
    expect(openRow?.querySelector(".dot.working")).toBeTruthy()
  })

  it("renders the recency divider only when an older section is non-empty", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [ROW_A], older: [ROW_CHILD] }))
    expect(el(panel, "list").innerHTML).toContain("Older than 24 hours")
  })

  it("shows the empty state when the list is empty, hides it otherwise", () => {
    const panel = renderPanel()
    expect(el(panel, "empty").hidden).toBe(true) // initial markup ships hidden
    send(panel, {
      type: "model",
      summary: "0 loaded",
      section: { recent: [], older: [] },
      workspaces: [],
      selectedWorkspace: "__all__",
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

  it("renders a workspace tag with its accent color", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const row = el(panel, "list").querySelector('[data-id="s1"]')!
    const tag = row.querySelector(".tag.workspace")
    expect(tag?.textContent).toBe("Agentik Studio")
    expect(htmlEl(tag).getAttribute("style")).toContain("#c45c26")
  })

  it("renders an unassigned workspace tag when no workspace is attached", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [ROW_DONE] }))
    const tag = el(panel, "list").querySelector('[data-id="s2"] .tag.workspace')
    expect(tag?.textContent).toBe("unassigned")
  })

  it("styles archived rows with reduced opacity", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [{ ...ROW_DONE, archived: true, action: "unarchive" }] }))
    const row = el(panel, "list").querySelector('[data-id="s2"]')!
    expect(row.className).toContain(" archived")
  })
})

describe("sessions webview — workspace selector", () => {
  it("renders global, each workspace, and unassigned options", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const select = el(panel, "workspace-select")
    const options = [...select.querySelectorAll("option")].map(o => ({
      value: htmlEl(o).getAttribute("value"),
      label: o.textContent,
    }))
    expect(options).toEqual([
      { value: "__all__", label: "Global / All workspaces" },
      { value: "studio", label: "Agentik Studio" },
      { value: "__unassigned__", label: "Unassigned" },
    ])
  })

  it("marks the selected workspace option and applies its accent color to the select border", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ selectedWorkspace: "studio" }))
    const select = el(panel, "workspace-select")
    const selected = htmlEl(select.querySelector('option[value="studio"]'))
    expect(selected.hasAttribute("selected")).toBe(true)
    expect(select.className).not.toContain("neutral")
    const style = htmlEl(select).getAttribute("style") ?? ""
    expect(style).toMatch(/border-left-color:\s*rgb\(196,\s*92,\s*38\)/)
  })

  it("keeps the neutral border for global / unassigned selections", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ selectedWorkspace: "__unassigned__" }))
    const select = el(panel, "workspace-select")
    expect(select.className).toContain("neutral")
    const style = htmlEl(select).getAttribute("style") ?? ""
    expect(style).not.toContain("rgb")
  })

  it("posts a workspace message when the selector changes", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const select = htmlEl(el(panel, "workspace-select")) as HTMLSelectElement
    select.value = "studio"
    change(panel, select as unknown as DomElement)
    expect(panel.posted).toEqual([{ type: "workspace", workspace: "studio" }])
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

  it("clicking the stop action posts stop with the row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const stopBtn = el(panel, "list").querySelector('[data-stop="s1"]')!
    click(panel, stopBtn)
    expect(panel.posted).toEqual([{ type: "stop", id: "s1" }])
  })

  it("clicking the archive action posts archive with the row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [ROW_DONE] }))
    panel.posted.length = 0
    const archiveBtn = el(panel, "list").querySelector('[data-archive="s2"]')!
    click(panel, archiveBtn)
    expect(panel.posted).toEqual([{ type: "archive", id: "s2" }])
  })

  it("clicking the unarchive action posts unarchive with the row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ recent: [{ ...ROW_DONE, archived: true, action: "unarchive" }] }))
    panel.posted.length = 0
    const unarchiveBtn = el(panel, "list").querySelector('[data-unarchive="s2"]')!
    click(panel, unarchiveBtn)
    expect(panel.posted).toEqual([{ type: "unarchive", id: "s2" }])
  })

  it("clicking a status tab marks it active and posts the tab id", () => {
    const panel = renderPanel()
    const workingTab = el(panel, "tabs").querySelector('[data-tab="working"]')!
    click(panel, workingTab)
    expect(workingTab.className).toContain("on")
    expect(el(panel, "tabs").querySelector('[data-tab="all"]')!.className).not.toContain("on")
    expect(panel.posted.at(-1)).toEqual({ type: "tab", tab: "working" })
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
