// @vitest-environment jsdom
/**
 * DOM-level coverage for the Sessions webview panel's shipped script (Design
 * B) — extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors transcriptPanel.dom.test.ts's pattern) so a regression in the
 * rendered markup or the click/keydown/filter/rail/segment/section wiring
 * fails this suite, not a hand-rolled model of it.
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

function send(panel: Panel, data: unknown): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data }))
}

const ROW_A = {
  id: "s1",
  open: false,
  status: "working",
  name: "openagentik-migration-lead",
  idMono: undefined,
  message: "Fanned out 3 executors.",
  tag: "in-place",
  harnessGlyph: "✳",
  model: "opus",
  ctxPercent: 71,
  cost: "$1.24",
  time: "now",
  unread: false,
  runs: undefined,
  approved: false,
  action: "stop",
  workspace: { slug: "studio", label: "Agentik Studio", colorIndex: 0, css: "#c45c26" },
  archived: false,
}

const ROW_DONE = {
  id: "s2",
  open: false,
  status: "done",
  name: "sales-analysis",
  idMono: undefined,
  message: undefined,
  tag: "in-place",
  harnessGlyph: "✳",
  model: undefined,
  ctxPercent: undefined,
  cost: undefined,
  time: "2h ago",
  unread: false,
  runs: undefined,
  approved: false,
  action: "archive",
  workspace: undefined,
  archived: false,
}

const CRON_ROW = {
  ...ROW_DONE,
  id: "c1",
  name: "cron",
  idMono: "d8ee2e36",
  runs: 3,
  action: "archive",
}

function group(key: string, label: string, rows: unknown[], hint?: string) {
  return { key, label, hint, rows }
}

function modelMessage(
  overrides: {
    groups?: unknown[]
    lane?: string
    project?: string | null
    rail?: unknown[]
    laneCounts?: { agents: number; auto: number }
    summary?: string
    loading?: boolean
    hasMore?: boolean
    loadError?: string
    connection?: unknown
    showArchived?: boolean
  } = {},
) {
  return {
    type: "model",
    summary: overrides.summary ?? "2 loaded",
    connection: overrides.connection,
    lane: overrides.lane ?? "agents",
    project: overrides.project ?? null,
    rail: overrides.rail ?? [
      { slug: null, label: "All", css: undefined, count: 2, awaiting: false },
      { slug: "studio", label: "Agentik Studio", css: "#c45c26", count: 2, awaiting: true },
    ],
    laneCounts: overrides.laneCounts ?? { agents: 2, auto: 0 },
    groups: overrides.groups ?? [group("running", "Running", [ROW_A])],
    loading: overrides.loading ?? false,
    hasMore: overrides.hasMore ?? false,
    loadError: overrides.loadError ?? undefined,
    showArchived: overrides.showArchived ?? false,
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
    expect([...el(panel, "list").querySelectorAll(".row")]).toHaveLength(1)
  })
})

describe("sessions webview — render", () => {
  it("renders each group as a collapsible header + its rows", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("needs-you", "Needs you", [ROW_A]), group("earlier", "Earlier", [ROW_DONE], "last 24 h")] }))
    const heads = [...el(panel, "list").querySelectorAll(".ghead")]
    expect(heads.map(h => htmlEl(h).getAttribute("data-key"))).toEqual(["needs-you", "earlier"])
    expect(el(panel, "list").innerHTML).toContain("last 24 h")
    expect([...el(panel, "list").querySelectorAll(".row")]).toHaveLength(2)
  })

  it("marks the row whose transcript tab is open with .open", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("running", "Running", [{ ...ROW_A, open: true }])] }))
    const openRow = el(panel, "list").querySelector('[data-id="s1"]')!
    expect(openRow.className).toContain(" open")
    expect(openRow.querySelector(".dot.working")).toBeTruthy()
  })

  it("shows the empty state when every group is empty, hides it otherwise", () => {
    const panel = renderPanel()
    expect(el(panel, "empty").hidden).toBe(true)
    send(panel, modelMessage({ groups: [] }))
    expect(el(panel, "empty").hidden).toBe(false)
    send(panel, modelMessage())
    expect(el(panel, "empty").hidden).toBe(true)
  })

  it("uses an archived-specific empty message in the archived-only view", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [] }))
    expect(htmlEl(el(panel, "empty")).textContent).toBe("No sessions match.")
    send(panel, modelMessage({ groups: [], showArchived: true }))
    expect(htmlEl(el(panel, "empty")).textContent).toBe("No archived sessions.")
  })

  it("writes the host-computed summary line verbatim into the footer", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ summary: "3 of 20 shown" }))
    expect(el(panel, "summary").textContent).toBe("3 of 20 shown")
  })

  it("renders the workspace color square + label in the meta row", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const proj = el(panel, "list").querySelector('[data-id="s1"] .meta .proj')
    expect(proj?.textContent).toContain("Agentik Studio")
    expect(htmlEl(proj!.querySelector(".psq")).getAttribute("style")).toContain("#c45c26")
  })

  it("renders an unassigned meta label when no workspace is attached", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("earlier", "Earlier", [ROW_DONE])] }))
    const proj = el(panel, "list").querySelector('[data-id="s2"] .meta .proj')
    expect(proj?.textContent).toContain("unassigned")
  })

  it("renders a collapsed cron row's split id and run count", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ lane: "auto", groups: [group("cron", "Crons", [CRON_ROW])] }))
    const row = el(panel, "list").querySelector('[data-id="c1"]')!
    expect(row.querySelector(".name .id")?.textContent).toBe("· d8ee2e36")
    expect(row.querySelector(".name .runs")?.textContent).toBe("×3 runs")
  })

  it("styles archived rows with reduced opacity", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("earlier", "Earlier", [{ ...ROW_DONE, archived: true, action: "unarchive" }])] }))
    expect(el(panel, "list").querySelector('[data-id="s2"]')!.className).toContain(" archived")
  })

  it("reflects segmented-control lane + counts", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ lane: "auto", laneCounts: { agents: 4, auto: 7 } }))
    const auto = el(panel, "seg").querySelector('[data-lane="auto"]')!
    const agents = el(panel, "seg").querySelector('[data-lane="agents"]')!
    expect(auto.className).toContain("on")
    expect(agents.className).not.toContain("on")
    expect(agents.querySelector(".n")?.textContent).toBe("4")
    expect(auto.querySelector(".n")?.textContent).toBe("7")
  })

  it("renders the project rail with counts and an ochre awaiting dot", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const chips = [...el(panel, "rail").querySelectorAll(".pchip")]
    expect(chips.map(c => htmlEl(c).getAttribute("data-slug"))).toEqual(["", "studio"])
    expect(chips[0]!.className).toContain("on") // All selected by default
    expect(chips[1]!.querySelector(".adot")).toBeTruthy()
  })

  it("shows/hides load-more and the loading indicator", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ hasMore: true, loading: true }))
    expect(el(panel, "load-more").hidden).toBe(false)
    expect(el(panel, "spinner").hidden).toBe(false)
    expect((htmlEl(el(panel, "load-more")) as HTMLButtonElement).disabled).toBe(true)
    send(panel, modelMessage({ hasMore: false, loading: false }))
    expect(el(panel, "load-more").hidden).toBe(true)
  })

  it("shows a footer error when loadError is set", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ loadError: "daemon unreachable" }))
    expect(el(panel, "footer-error").hidden).toBe(false)
    expect(el(panel, "footer-error").textContent).toBe("daemon unreachable")
  })
})

describe("sessions webview — interactions", () => {
  it("clicking a row posts open with that row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector('[data-id="s1"]')!)
    expect(panel.posted).toEqual([{ type: "open", id: "s1" }])
  })

  it("renders accessible lifecycle action buttons in a stable slot", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const stopBtn = htmlEl(el(panel, "list").querySelector('[data-stop="s1"]'))
    expect(stopBtn.getAttribute("aria-label")).toBe("Stop session")
    expect(stopBtn.className).toContain("abtn")
    expect(stopBtn.className).toContain("stop")
  })

  it("clicking stop posts stop and optimistically shows a Stopping… spinner", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector('[data-stop="s1"]')!)
    expect(panel.posted).toEqual([{ type: "stop", id: "s1" }])
    const row = el(panel, "list").querySelector('[data-id="s1"]')!
    expect(row.querySelector(".spin")).toBeTruthy()
    expect(row.querySelector(".msg")?.textContent).toBe("Stopping…")
  })

  it("clicking archive posts archive and slides the row away", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("earlier", "Earlier", [ROW_DONE])] }))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector('[data-archive="s2"]')!)
    expect(panel.posted).toEqual([{ type: "archive", id: "s2" }])
    expect(el(panel, "list").querySelector('[data-id="s2"]')!.className).toContain("gone")
  })

  it("clicking unarchive posts unarchive with the row's id", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("earlier", "Earlier", [{ ...ROW_DONE, archived: true, action: "unarchive" }])] }))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector('[data-unarchive="s2"]')!)
    expect(panel.posted).toEqual([{ type: "unarchive", id: "s2" }])
  })

  it("clicking a segment posts the lane switch", () => {
    const panel = renderPanel()
    click(panel, el(panel, "seg").querySelector('[data-lane="auto"]')!)
    expect(panel.posted.at(-1)).toEqual({ type: "lane", lane: "auto" })
  })

  it("clicking a project chip posts the project selection (empty slug → null)", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    click(panel, el(panel, "rail").querySelector('[data-slug="studio"]')!)
    expect(panel.posted.at(-1)).toEqual({ type: "project", slug: "studio" })
    click(panel, el(panel, "rail").querySelector('[data-slug=""]')!)
    expect(panel.posted.at(-1)).toEqual({ type: "project", slug: null })
  })

  it("clicking a section header collapses and re-expands its rows", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("running", "Running", [ROW_A])] }))
    const head = el(panel, "list").querySelector('.ghead[data-key="running"]')!
    const body = el(panel, "list").querySelector('.gbody[data-body="running"]')!
    expect(htmlEl(body).hidden).toBe(false)
    click(panel, head)
    expect(htmlEl(body).hidden).toBe(true)
    expect(head.className).toContain("closed")
    click(panel, head)
    expect(htmlEl(body).hidden).toBe(false)
  })

  it("typing in the filter posts a filter message with the trimmed text", async () => {
    const panel = renderPanel()
    const q = el(panel, "q")
    ;(q as unknown as HTMLInputElement).value = "  sales  "
    q.dispatchEvent(new panel.window.Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(panel.posted.at(-1)).toEqual({ type: "filter", search: "sales" })
  })

  it("clicking load-more posts a loadMore message", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ hasMore: true }))
    panel.posted.length = 0
    click(panel, el(panel, "load-more"))
    expect(panel.posted).toEqual([{ type: "loadMore" }])
  })

  it("clicking the archived toggle posts toggleArchived and reflects showArchived as an archived-only view switch", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    expect(htmlEl(el(panel, "arch-toggle")).getAttribute("title")).toBe("Show archived only")
    expect(htmlEl(el(panel, "arch-toggle")).getAttribute("aria-label")).toBe("Show archived only")
    panel.posted.length = 0
    click(panel, el(panel, "arch-toggle"))
    expect(panel.posted).toEqual([{ type: "toggleArchived" }])
    send(panel, modelMessage({ showArchived: true }))
    expect(el(panel, "arch-toggle").classList.contains("on")).toBe(true)
    expect(htmlEl(el(panel, "arch-toggle")).getAttribute("aria-pressed")).toBe("true")
    expect(htmlEl(el(panel, "arch-toggle")).getAttribute("title")).toBe("Show active sessions")
    expect(htmlEl(el(panel, "arch-toggle")).getAttribute("aria-label")).toBe("Show active sessions")
  })

  it("renders the archived toggle as an archive-box icon, not the stop-lookalike glyph", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const toggle = el(panel, "arch-toggle")
    expect(toggle.querySelector("svg")).toBeTruthy()
    expect(toggle.textContent).not.toContain("▣")
    const stopSvg = htmlEl(el(panel, "list").querySelector('[data-stop="s1"]'))!.querySelector("svg")!
    expect(toggle.querySelector("svg")!.innerHTML).not.toBe(stopSvg.innerHTML)
  })
})

describe("sessions webview — watched + nesting (items 5, 6)", () => {
  it("renders a watched indicator for a kept-alive row", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("running", "Running", [{ ...ROW_A, watched: true }])] }))
    expect(el(panel, "list").querySelector(".name .watch")).not.toBeNull()
  })

  it("indents a nested subagent row by its depth", () => {
    const panel = renderPanel()
    send(panel, modelMessage({ groups: [group("running", "Running", [ROW_A, { ...ROW_DONE, depth: 1 }])] }))
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    const nested = rows.find(r => htmlEl(r).classList.contains("nested"))!
    expect(nested).toBeTruthy()
    expect(htmlEl(nested).getAttribute("style")).toContain("padding-left")
    expect(htmlEl(nested).querySelector(".lineage")).not.toBeNull()
  })
})
