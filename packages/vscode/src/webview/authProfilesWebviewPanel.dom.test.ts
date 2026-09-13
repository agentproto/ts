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
  curatedModels: [
    { id: "anthropic/claude-fable-5", status: "active", hint: "active — this wallet bills it" },
    {
      id: "anthropic/claude-opus-4-8",
      status: "unbillable",
      hint: "no connected wallet can bill this model on anthropic — check this wallet's credential",
    },
  ],
}

const UNCURATED_WALLET = {
  ...CURATED_WALLET,
  id: "anthropic-key",
  label: "anthropic-key",
  accessKind: "api-key",
  curationSummary: "no catalog models",
  curatedIds: [],
  curatedModels: [],
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

  it("renders a status dot + reason tooltip per curated chip, so inactive vs unbillable is visible", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const card = el(panel, "list").querySelector(".wcard")!
    const chips = [...card.querySelectorAll(".curated-chips .chip")].map(htmlEl)
    expect(chips[0]!.querySelector(".mdot.active")).toBeTruthy()
    expect(chips[0]!.getAttribute("title")).toContain("this wallet bills it")
    expect(chips[1]!.querySelector(".mdot.unbillable")).toBeTruthy()
    expect(chips[1]!.getAttribute("title")).toContain("no connected wallet can bill this model")
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

describe("wallets webview — wallet card actions", () => {
  it("renders the set-models / toggle / delete actions inline in the card header, not hover-gated", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    const card = htmlEl(el(panel, "list").querySelector(".wcard"))
    const actions = card.querySelector(".wtop .wactions")
    expect(actions).toBeTruthy()
    expect(actions!.querySelector("[data-set-models]")).toBeTruthy()
    expect(actions!.querySelector("[data-toggle]")).toBeTruthy()
    expect(actions!.querySelector("[data-delete]")).toBeTruthy()
  })

  it("clicking the + action posts requestSetModels with the wallet id", () => {
    const panel = renderPanel()
    send(panel, modelMessage())
    panel.posted.length = 0
    const card = el(panel, "list").querySelector(".wcard")!
    click(panel, card.querySelector("[data-set-models]")!)
    expect(panel.posted).toEqual([{ type: "requestSetModels", profileId: "anthropic-sub" }])
  })
})

describe("wallets webview — allowed-models dialog", () => {
  const DIALOG = {
    type: "setModelsDialog",
    profileId: "openrouter-env",
    items: [
      { id: "deepseek/deepseek-v4-flash-0731", label: "deepseek/deepseek-v4-flash-0731", picked: false },
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", picked: true },
      { id: "anthropic/claude-fable-latest", label: "~anthropic/claude-fable-latest", picked: true },
    ],
  }

  function input(panel: Panel, element: DomElement, value: string): void {
    ;(element as unknown as HTMLInputElement).value = value
    element.dispatchEvent(new panel.window.Event("input", { bubbles: true }))
  }

  it("renders a filter input above the model list and filters items as you type", () => {
    const panel = renderPanel()
    send(panel, DIALOG)
    const filter = el(panel, "model-filter")
    const items = [...el(panel, "dialog-body").querySelectorAll(".model-item")].map(htmlEl)
    expect(items).toHaveLength(3)
    input(panel, filter, "flash 0731")
    expect(items.map(i => i.style.display)).toEqual(["", "none", "none"])
    input(panel, filter, "")
    expect(items.map(i => i.style.display)).toEqual(["", "", ""])
  })

  it("saving posts every checked model, including ones hidden by the filter", () => {
    const panel = renderPanel()
    send(panel, DIALOG)
    panel.posted.length = 0
    const flash = htmlEl(el(panel, "dialog-body").querySelector('[data-model-id="deepseek/deepseek-v4-flash-0731"]'))
    ;(flash as HTMLInputElement).checked = true
    input(panel, el(panel, "model-filter"), "claude")
    click(panel, el(panel, "dialog-confirm"))
    expect(panel.posted).toEqual([
      {
        type: "setModels",
        profileId: "openrouter-env",
        ids: [
          "deepseek/deepseek-v4-flash-0731",
          "deepseek/deepseek-v4-pro",
          "anthropic/claude-fable-latest",
        ],
      },
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
