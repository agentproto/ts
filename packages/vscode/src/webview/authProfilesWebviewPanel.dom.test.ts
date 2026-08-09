// @vitest-environment jsdom
/**
 * DOM-level coverage for the Wallets webview panel's shipped script —
 * extracts and executes the REAL HTML/script via the exported `buildHtml`
 * (mirrors harnessesWebview.dom.test.ts's own pattern) so a regression in the
 * rendered markup or the click wiring fails this suite, not just a
 * hand-rolled model of it.
 *
 * Covers what moved here from the (now redirector) Auth Settings panel: the
 * "+ Add wallet" flow, and per-wallet curation editing collapsed by default
 * behind a client-side expand toggle (no host round-trip) with a "×" chip
 * remove that does round-trip.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./authProfilesWebviewPanel.js"

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

const CURATED_WALLET = {
  id: "anthropic-sub",
  label: "anthropic-sub",
  endpoint: "anthropic",
  accessKind: "subscription-refreshing",
  method: "oauth-bearer",
  keyStatus: "self-refreshing",
  credential: "source · claude-code-oauth",
  models: "4 allowed",
  disabled: false,
  enabled: true,
  curationSummary: "4 curated · 4 active",
  curatedIds: ["anthropic/claude-fable-5", "anthropic/claude-opus-4-8"],
}

const UNCURATED_WALLET = {
  ...CURATED_WALLET,
  id: "anthropic-key",
  label: "anthropic-key",
  accessKind: "api-key",
  curationSummary: "no catalog models",
  curatedIds: [],
}

const PROVIDER = {
  endpoint: "anthropic",
  native: "Anthropic",
  logo: { kind: "lettermark", text: "A" },
  wallets: [CURATED_WALLET, UNCURATED_WALLET],
  subscriptionCount: 1,
  apiKeyCount: 1,
  primary: true,
}

function modelMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "model",
    model: {
      providers: { kind: "providers", label: "Wallets", count: 2, expanded: true, rows: [PROVIDER] },
      unconnected: [],
      moreCount: 0,
      router: { kind: "router", label: "Local Router", count: "stopped", expanded: false, rows: [] },
      ...overrides,
    },
    search: "",
  }
}

describe("wallets webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("wallets webview — render", () => {
  it("renders the curation summary line instead of a raw model count", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const cards = [...el(panel, "list").querySelectorAll(".wcard")]
    expect(cards).toHaveLength(2)
    expect(htmlEl(cards[0]!).textContent).toContain("4 curated · 4 active")
  })

  it("shows a curation-toggle only for a wallet with curated ids, and hides the chip wall by default", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const cards = [...el(panel, "list").querySelectorAll(".wcard")]
    const curatedCard = htmlEl(cards[0]!)
    const uncuratedCard = htmlEl(cards[1]!)
    expect(curatedCard.querySelector("[data-curation-toggle]")).toBeTruthy()
    expect(uncuratedCard.querySelector("[data-curation-toggle]")).toBeFalsy()
    // Collapsed by default — no chip wall showing without a click.
    expect(curatedCard.querySelector(".curated-chips.show")).toBeFalsy()
    expect(curatedCard.querySelectorAll(".curated-chips .chip")).toHaveLength(2)
  })
})

describe("wallets webview — curation editing (migrated from Auth Settings)", () => {
  it("expands the curated-chip wall in place on click, without a host round-trip", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const card = el(panel, "list").querySelector(".wcard")!
    click(panel, card.querySelector("[data-curation-toggle]")!)
    expect(htmlEl(card.querySelector(".curated-chips")).className).toContain("show")
    expect(panel.posted).toEqual([])
  })

  it("clicking a chip's × posts removeModel with the wallet id and model id", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const card = el(panel, "list").querySelector(".wcard")!
    click(panel, card.querySelector("[data-remove-model]")!)
    expect(panel.posted).toEqual([
      { type: "removeModel", profileId: "anthropic-sub", model: "anthropic/claude-fable-5" },
    ])
  })
})

describe("wallets webview — add wallet (migrated from Auth Settings)", () => {
  it("clicking '+ Add wallet' posts addProfile", () => {
    const panel = renderPanel()
    panel.posted.length = 0
    click(panel, el(panel, "addwallet"))
    expect(panel.posted).toEqual([{ type: "addProfile" }])
  })
})

describe("wallets webview — cross-link", () => {
  it("clicking the map link posts openMap", () => {
    const panel = renderPanel()
    panel.posted.length = 0
    click(panel, el(panel, "maplink"))
    expect(panel.posted).toEqual([{ type: "openMap" }])
  })
})
