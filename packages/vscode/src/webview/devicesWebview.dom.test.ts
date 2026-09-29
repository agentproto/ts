// @vitest-environment jsdom
/**
 * DOM-level coverage for the Devices webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors harnessesWebview.dom.test.ts's own pattern) so a regression in
 * the rendered markup or the click wiring fails this suite, not just a
 * hand-rolled model of it.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./devicesWebviewPanel.js"

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

const THIS_MACHINE_ROW = {
  id: "this-machine",
  isThisMachine: true,
  name: "jeremys-mac",
  roleLabel: "This machine",
  kindLabel: "daemon v0.42.0",
  online: true,
  hostScoped: false,
  legacy: false,
  lastSeenLabel: "active now",
  detail: "2 sessions",
  expandable: false,
  fingerprint: undefined,
  sessions: undefined,
}

const CLIENT_ROW = {
  id: "fp-1",
  isThisMachine: false,
  name: "Jeremy's Phone",
  roleLabel: "Client",
  kindLabel: "browser",
  online: true,
  hostScoped: false,
  legacy: false,
  lastSeenLabel: "5 mins ago",
  detail: "fp-1",
  expandable: false,
  fingerprint: "fp-1",
  sessions: undefined,
}

const HOST_ROW = {
  id: "fp-host",
  isThisMachine: false,
  name: "Scratch Host",
  roleLabel: "Host",
  kindLabel: "daemon",
  online: false,
  hostScoped: true,
  legacy: false,
  lastSeenLabel: "2 hrs ago",
  detail: "fp-host",
  expandable: true,
  fingerprint: "fp-host",
  sessions: undefined,
}

function modelMessage(rows: unknown[], opts: { connection?: string; loadError?: string } = {}) {
  return {
    type: "model",
    connection: opts.connection ?? "connected",
    rows,
    loadError: opts.loadError,
  }
}

describe("devices webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("devices webview — render", () => {
  it("shows the daemon-connecting state and hides the list while disconnected", () => {
    const panel = renderPanel()
    send(panel, modelMessage([THIS_MACHINE_ROW], { connection: "connecting" }))
    expect(panel.document.body.classList.contains("daemon-state")).toBe(true)
  })

  it("renders one row per device plus the this-machine row", () => {
    const panel = renderPanel()
    send(panel, modelMessage([THIS_MACHINE_ROW, CLIENT_ROW, HOST_ROW]))
    expect(panel.document.body.classList.contains("daemon-state")).toBe(false)
    const rows = [...el(panel, "list").querySelectorAll(".row")]
    expect(rows).toHaveLength(3)
  })

  it("renders the this-machine row with no action menu and no expand twist", () => {
    const panel = renderPanel()
    send(panel, modelMessage([THIS_MACHINE_ROW]))
    const row = el(panel, "list").querySelector('.row[data-id="this-machine"]')!
    expect(htmlEl(row.querySelector(".menu-btn")).hasAttribute("hidden")).toBe(true)
    expect(htmlEl(row.querySelector(".twist")).hasAttribute("hidden")).toBe(true)
  })

  it("renders an expand twist only for an expandable (host) row", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW, HOST_ROW]))
    const clientRow = el(panel, "list").querySelector('.row[data-id="fp-1"]')!
    const hostRow = el(panel, "list").querySelector('.row[data-id="fp-host"]')!
    expect(htmlEl(clientRow.querySelector(".twist")).hasAttribute("hidden")).toBe(true)
    expect(htmlEl(hostRow.querySelector(".twist")).hasAttribute("hidden")).toBe(false)
  })

  it("greys out an offline device row", () => {
    const panel = renderPanel()
    send(panel, modelMessage([HOST_ROW]))
    const row = el(panel, "list").querySelector('.row[data-id="fp-host"]')!
    expect(htmlEl(row).className).toContain("offline")
  })

  it("renders a host-scoped chip when the row flags it", () => {
    const panel = renderPanel()
    send(panel, modelMessage([HOST_ROW]))
    expect(el(panel, "list").querySelector(".chip.host-scoped")).toBeTruthy()
  })

  it("renders nested session rows when a host row carries loaded sessions state", () => {
    const panel = renderPanel()
    const expandedHost = {
      ...HOST_ROW,
      sessions: { status: "loaded", rows: [{ id: "s1", name: "agent-cli · s1", status: "working", ageLabel: "2 mins ago" }] },
    }
    send(panel, modelMessage([expandedHost]))
    const sessions = el(panel, "list").querySelector('.sessions[data-owner="fp-host"]')!
    const srows = [...sessions.querySelectorAll(".srow")]
    expect(srows).toHaveLength(1)
    expect(htmlEl(srows[0]!).textContent).toContain("agent-cli · s1")
  })

  it("renders a loading placeholder for an expanded host still fetching sessions", () => {
    const panel = renderPanel()
    send(panel, modelMessage([{ ...HOST_ROW, sessions: { status: "loading" } }]))
    expect(el(panel, "list").querySelector(".sstate")!.textContent).toContain("Loading")
  })

  it("renders an error state for a host whose session fetch failed", () => {
    const panel = renderPanel()
    send(panel, modelMessage([{ ...HOST_ROW, sessions: { status: "error", message: "device unreachable" } }]))
    const state = el(panel, "list").querySelector(".sstate.error")!
    expect(state.textContent).toBe("device unreachable")
  })

  it("renders self-reported labels in a host's meta line (SANDBOX-VISIBILITY-JOIN #1)", () => {
    const panel = renderPanel()
    send(panel, modelMessage([{ ...HOST_ROW, detail: "e2b · fp-host · pr=1536, repo=agentproto/ts" }]))
    const row = el(panel, "list").querySelector('.row[data-id="fp-host"]')!
    expect(row.querySelector(".meta")!.textContent).toBe("e2b · fp-host · pr=1536, repo=agentproto/ts")
  })

  it("renders a stale banner above the session list when the host is offline (SANDBOX-VISIBILITY-JOIN #3)", () => {
    const panel = renderPanel()
    const expandedHost = {
      ...HOST_ROW,
      sessions: {
        status: "loaded",
        rows: [{ id: "s1", name: "agent-cli · s1", status: "working", ageLabel: "2 mins ago" }],
        stale: true,
        staleLabel: "captured 4 mins ago",
      },
    }
    send(panel, modelMessage([expandedHost]))
    const staleBanner = el(panel, "list").querySelector('.sessions[data-owner="fp-host"] .sstate.stale')!
    expect(staleBanner.textContent).toContain("Host offline")
    expect(staleBanner.textContent).toContain("captured 4 mins ago")
    // The (stale) session rows themselves still render alongside the banner.
    const srows = [...el(panel, "list").querySelectorAll('.sessions[data-owner="fp-host"] .srow')]
    expect(srows).toHaveLength(1)
  })

  it("omits the stale banner for a live (non-stale) loaded sessions state", () => {
    const panel = renderPanel()
    const expandedHost = { ...HOST_ROW, sessions: { status: "loaded", rows: [] } }
    send(panel, modelMessage([expandedHost]))
    expect(el(panel, "list").querySelector(".sstate.stale")).toBeNull()
  })
})

describe("devices webview — interactions", () => {
  it("clicking a host row's expand twist posts toggleExpand with its id", () => {
    const panel = renderPanel()
    send(panel, modelMessage([HOST_ROW]))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector(".twist")!)
    expect(panel.posted).toEqual([{ type: "toggleExpand", id: "fp-host" }])
  })

  it("clicking a session row posts openSession with device/session ids", () => {
    const panel = renderPanel()
    const expandedHost = {
      ...HOST_ROW,
      sessions: { status: "loaded", rows: [{ id: "s1", name: "agent-cli · s1", status: "working", ageLabel: "2 mins ago" }] },
    }
    send(panel, modelMessage([expandedHost]))
    panel.posted.length = 0
    click(panel, el(panel, "list").querySelector(".srow")!)
    expect(panel.posted).toEqual([
      { type: "openSession", deviceId: "fp-host", sessionId: "s1", sessionName: "agent-cli · s1" },
    ])
  })

  it("clicking a device row's menu button opens a menu with rename/revoke/copy actions", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW]))
    click(panel, el(panel, "list").querySelector(".menu-btn")!)
    const menu = el(panel, "menu")
    expect(htmlEl(menu).hasAttribute("hidden")).toBe(false)
    const acts = [...menu.querySelectorAll("button")].map(b => htmlEl(b).getAttribute("data-menu-act"))
    expect(acts).toEqual(["rename", "copyFingerprint", "revoke"])
  })

  it("clicking the menu's Rename action posts rename with the device id and closes the menu", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW]))
    click(panel, el(panel, "list").querySelector(".menu-btn")!)
    panel.posted.length = 0
    click(panel, el(panel, "menu").querySelector('[data-menu-act="rename"]')!)
    expect(panel.posted).toEqual([{ type: "rename", id: "fp-1" }])
    expect(htmlEl(el(panel, "menu")).hasAttribute("hidden")).toBe(true)
  })

  it("clicking the menu's Revoke action posts revoke with the device id", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW]))
    click(panel, el(panel, "list").querySelector(".menu-btn")!)
    panel.posted.length = 0
    click(panel, el(panel, "menu").querySelector('[data-menu-act="revoke"]')!)
    expect(panel.posted).toEqual([{ type: "revoke", id: "fp-1" }])
  })

  it("clicking the menu's Copy fingerprint action posts copyFingerprint with the device id", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW]))
    click(panel, el(panel, "list").querySelector(".menu-btn")!)
    panel.posted.length = 0
    click(panel, el(panel, "menu").querySelector('[data-menu-act="copyFingerprint"]')!)
    expect(panel.posted).toEqual([{ type: "copyFingerprint", id: "fp-1" }])
  })

  it("clicking the same menu button twice closes the menu instead of reopening it", () => {
    const panel = renderPanel()
    send(panel, modelMessage([CLIENT_ROW]))
    const menuBtn = el(panel, "list").querySelector(".menu-btn")!
    click(panel, menuBtn)
    expect(htmlEl(el(panel, "menu")).hasAttribute("hidden")).toBe(false)
    click(panel, menuBtn)
    expect(htmlEl(el(panel, "menu")).hasAttribute("hidden")).toBe(true)
  })

  it("clicking the refresh button posts refresh", () => {
    const panel = renderPanel()
    send(panel, modelMessage([THIS_MACHINE_ROW]))
    panel.posted.length = 0
    click(panel, el(panel, "refresh"))
    expect(panel.posted).toEqual([{ type: "refresh" }])
  })

  it("surfaces a load error in the error banner", () => {
    const panel = renderPanel()
    send(panel, modelMessage([THIS_MACHINE_ROW], { loadError: "daemon unreachable" }))
    const error = el(panel, "error")
    expect(htmlEl(error).hasAttribute("hidden")).toBe(false)
    expect(error.textContent).toBe("daemon unreachable")
  })
})
