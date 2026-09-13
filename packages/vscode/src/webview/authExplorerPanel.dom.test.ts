// @vitest-environment jsdom
/**
 * DOM-level coverage for the Auth & Models explorer webview — executes the
 * REAL shipped HTML/script via the exported `buildAuthExplorerHtml` (same
 * pattern as authProfilesWebviewPanel.dom.test.ts), so a regression in the
 * rendered markup or click wiring fails this suite.
 */
import type { DomDocument, DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildAuthExplorerHtml } from "./authExplorerPanel.js"
import type { AuthExplorerView } from "./authExplorer.logic.js"

interface Panel {
  window: DomWindow
  document: DomDocument
  posted: unknown[]
}

const openWindows: DomWindow[] = []

function renderPanel(): Panel {
  const posted: unknown[] = []
  const dom = new JSDOM(buildAuthExplorerHtml("test-nonce"), {
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
  if (!found) throw new Error(`#${id} missing from buildAuthExplorerHtml output`)
  return found
}

function click(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("click", { bubbles: true }))
}

function change(panel: Panel, element: DomElement): void {
  element.dispatchEvent(new panel.window.Event("change", { bubbles: true }))
}

function send(panel: Panel, view: AuthExplorerView): void {
  panel.window.dispatchEvent(new panel.window.MessageEvent("message", { data: { type: "model", view } }))
}

const VIEW: AuthExplorerView = {
  providers: [
    {
      slug: "openrouter",
      name: "OpenRouter",
      connected: true,
      wallets: [
        {
          id: "openrouter-env",
          label: "OpenRouter (env key)",
          endpoint: "openrouter",
          accessKind: "api-key",
          enabled: true,
          credential: "key fp 6931 · ····c160",
          curationMode: "allow",
          unlistedIds: ["deepseek/typo-model"],
          models: [
            {
              vendor: "deepseek",
              product: "deepseek-v4-flash",
              ref: "deepseek/deepseek-v4-flash@openrouter",
              writeId: "deepseek/deepseek-v4-flash",
              allowed: true,
              status: "active",
              hint: "active — this wallet bills it",
              price: "$0.3/$1.2 per 1M",
            },
            {
              vendor: "deepseek",
              product: "deepseek-v4-pro",
              ref: "deepseek/deepseek-v4-pro@openrouter",
              writeId: "deepseek/deepseek-v4-pro",
              allowed: false,
              status: "unbillable",
              hint: "no connected wallet can bill this model on openrouter — check this wallet's credential",
            },
          ],
          catalogCount: 2,
          allowedCount: 1,
          activeCount: 1,
          usedByPresets: [{ id: "fav-1", label: "Cheap", harness: "hermes", model: "deepseek-v4-flash" }],
          upstreamOf: ["openrouter"],
        },
      ],
      upstream: {
        linkedProfile: null,
        eligible: [{ id: "openrouter-env", label: "OpenRouter (env key)" }],
      },
    },
    { slug: "deepseek", name: "DeepSeek", connected: false, wallets: [] },
  ],
  harnesses: [
    {
      slug: "hermes",
      name: "hermes",
      protocol: "acp",
      presets: [{ id: "fav-1", label: "Cheap", harness: "hermes", model: "deepseek-v4-flash" }],
    },
  ],
  multiServed: [
    {
      key: "deepseek/deepseek-v4-flash",
      servedBy: [
        {
          profileId: "openrouter-env",
          label: "OpenRouter (env key)",
          endpoint: "openrouter",
          ref: "deepseek/deepseek-v4-flash@openrouter",
          active: true,
        },
        { profileId: "or-2", label: "Second", endpoint: "openrouter", ref: "x@openrouter", active: true },
      ],
    },
  ],
  router: { running: true, label: "router running :8788" },
  counts: { wallets: 1, providers: 1, harnesses: 1, presets: 1 },
}

function selectWallet(panel: Panel): void {
  send(panel, VIEW)
  const walletRow = el(panel, "tree").querySelector('[data-sel="wallet"]')!
  click(panel, walletRow)
}

describe("auth explorer webview — boot & rail", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })

  it("renders providers, connectable presets, harnesses and the models pivot in the rail", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    const tree = htmlEl(el(panel, "tree"))
    expect(tree.querySelectorAll('[data-sel="provider"]')).toHaveLength(1)
    expect(tree.querySelectorAll('[data-sel="wallet"]')).toHaveLength(1)
    expect(tree.querySelectorAll("[data-connect]")).toHaveLength(1)
    expect(tree.querySelectorAll('[data-sel="harness"]')).toHaveLength(1)
    expect(tree.querySelectorAll('[data-sel="model"]')).toHaveLength(1)
    expect(htmlEl(el(panel, "counts-pill")).textContent).toContain("1 wallets")
  })

  it("defaults the detail pane to the first connected provider", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    expect(htmlEl(el(panel, "detail")).textContent).toContain("Wallets (1)")
  })

  it("clicking an unconnected provider posts connectProvider", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    panel.posted.length = 0
    click(panel, el(panel, "tree").querySelector("[data-connect]")!)
    expect(panel.posted).toEqual([{ type: "connectProvider", slug: "deepseek" }])
  })
})

describe("auth explorer webview — wallet detail editing", () => {
  it("shows the allowed-models editor with status dots and hints", () => {
    const panel = renderPanel()
    selectWallet(panel)
    const detail = htmlEl(el(panel, "detail"))
    expect(detail.textContent).toContain("Allowed models")
    const rows = detail.querySelectorAll("[data-model]")
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector(".mdot.active")).toBeTruthy()
    expect(rows[1]!.querySelector(".mdot.unbillable")).toBeTruthy()
    expect(rows[1]!.getAttribute("title")).toContain("no connected wallet can bill this model")
  })

  it("clicking a model row posts toggleModel with the wallet id and writeId", () => {
    const panel = renderPanel()
    selectWallet(panel)
    panel.posted.length = 0
    click(panel, el(panel, "detail").querySelector('[data-model="deepseek/deepseek-v4-pro"]')!)
    expect(panel.posted).toEqual([
      { type: "toggleModel", profileId: "openrouter-env", writeId: "deepseek/deepseek-v4-pro" },
    ])
  })

  it("clicking a vendor head posts toggleVendor", () => {
    const panel = renderPanel()
    selectWallet(panel)
    panel.posted.length = 0
    click(panel, el(panel, "detail").querySelector('[data-vendor="deepseek"]')!)
    expect(panel.posted).toEqual([{ type: "toggleVendor", profileId: "openrouter-env", vendor: "deepseek" }])
  })

  it("filtering models hides non-matching rows", () => {
    const panel = renderPanel()
    selectWallet(panel)
    const filter = el(panel, "detail").querySelector("#model-filter")!
    ;(filter as unknown as HTMLInputElement).value = "flash"
    filter.dispatchEvent(new panel.window.Event("input", { bubbles: true }))
    const rows = [...el(panel, "detail").querySelectorAll("[data-model]")]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute("data-model")).toBe("deepseek/deepseek-v4-flash")
  })

  it("renders unlisted allowlist ids as removable chips posting removeUnlisted", () => {
    const panel = renderPanel()
    selectWallet(panel)
    panel.posted.length = 0
    click(panel, el(panel, "detail").querySelector("[data-remove-unlisted]")!)
    expect(panel.posted).toEqual([
      { type: "removeUnlisted", profileId: "openrouter-env", id: "deepseek/typo-model" },
    ])
  })

  it("the enabled switch posts setEnabled and the delete button posts deleteProfile", () => {
    const panel = renderPanel()
    selectWallet(panel)
    panel.posted.length = 0
    const toggle = el(panel, "detail").querySelector("[data-enable]")!
    ;(toggle as unknown as HTMLInputElement).checked = false
    change(panel, toggle)
    click(panel, el(panel, "detail").querySelector("[data-delete]")!)
    expect(panel.posted).toEqual([
      { type: "setEnabled", profileId: "openrouter-env", enabled: false },
      { type: "deleteProfile", profileId: "openrouter-env" },
    ])
  })
})

describe("auth explorer webview — provider, harness & pivot details", () => {
  it("changing the upstream select posts setUpstreamLink", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    const select = el(panel, "detail").querySelector("[data-upstream]")!
    ;(select as unknown as HTMLSelectElement).value = "openrouter-env"
    change(panel, select)
    expect(panel.posted).toContainEqual({
      type: "setUpstreamLink",
      provider: "openrouter",
      profileId: "openrouter-env",
    })
  })

  it("harness detail lists presets and delete posts deletePreset", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    click(panel, el(panel, "tree").querySelector('[data-sel="harness"]')!)
    expect(htmlEl(el(panel, "detail")).textContent).toContain("Presets (1)")
    panel.posted.length = 0
    click(panel, el(panel, "detail").querySelector("[data-delete-preset]")!)
    expect(panel.posted).toEqual([{ type: "deletePreset", presetId: "fav-1" }])
  })

  it("model pivot detail lists serving wallets and navigates to a wallet on click", () => {
    const panel = renderPanel()
    send(panel, VIEW)
    click(panel, el(panel, "tree").querySelector('[data-sel="model"]')!)
    expect(htmlEl(el(panel, "detail")).textContent).toContain("Served by 2 wallets")
    click(panel, el(panel, "detail").querySelector('[data-sel="wallet"]')!)
    expect(htmlEl(el(panel, "detail")).textContent).toContain("Allowed models")
  })

  it("refresh and add-wallet buttons post their messages", () => {
    const panel = renderPanel()
    panel.posted.length = 0
    click(panel, el(panel, "refresh"))
    click(panel, el(panel, "add-wallet"))
    expect(panel.posted).toEqual([{ type: "refresh" }, { type: "addWallet" }])
  })
})
