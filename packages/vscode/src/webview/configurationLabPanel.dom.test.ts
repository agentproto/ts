// @vitest-environment jsdom
/**
 * DOM-level coverage for the Configuration Lab webview panel's shipped script.
 * Extracts and executes the real HTML/script via the exported `buildHtml` so
 * regressions in the rendered markup or selection wiring fail here.
 */

import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { buildHtml } from "./configurationLabPanel.js"
import type { ConfigurationLabSnapshot } from "../client/types.js"
import type { DomWindow, DomDocument, DomElement } from "jsdom"

interface Panel {
  window: DomWindow
  document: DomDocument
  posted: unknown[]
}

const openWindows: DomWindow[] = []

function renderPanel(): Panel {
  const posted: unknown[] = []
  const dom = new JSDOM(buildHtml("test-nonce", "vscode-resource://"), {
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

function send(panel: Panel, snapshot: ConfigurationLabSnapshot): void {
  panel.window.dispatchEvent(
    new panel.window.MessageEvent("message", { data: { type: "snapshot", snapshot } }),
  )
}

function snapshot(overrides: Partial<ConfigurationLabSnapshot> = {}): ConfigurationLabSnapshot {
  return {
    selection: {},
    adapters: [
      { slug: "claude-code", name: "Claude Code", status: "ready" },
      { slug: "codex", name: "Codex", status: "ready" },
    ],
    harness: null,
    axes: { models: [], routes: [], profiles: [], postures: [], efforts: [] },
    effective: [],
    issues: [],
    ...overrides,
  }
}

function select(panel: Panel, id: string, value: string): void {
  const selectEl = el(panel, id) as unknown as { value: string; dispatchEvent: (e: unknown) => boolean }
  selectEl.value = value
  selectEl.dispatchEvent(new panel.window.Event("change", { bubbles: true }))
}

function selectValue(panel: Panel, id: string): string {
  return (el(panel, id) as unknown as { value: string }).value
}

function isDisabled(panel: Panel, id: string): boolean {
  return (el(panel, id) as unknown as { disabled: boolean }).disabled
}

function optionsLength(panel: Panel, id: string): number {
  return (el(panel, id) as unknown as { options: { length: number } }).options.length
}

function optionText(panel: Panel, id: string, index: number): string | undefined {
  const opts = (el(panel, id) as unknown as { options: Record<number, { text?: string } | undefined> & { length: number } }).options
  return opts[index]?.text
}

function click(panel: Panel, id: string): void {
  el(panel, id).dispatchEvent(new panel.window.Event("click", { bubbles: true }))
}

describe("configuration lab webview — boot", () => {
  it("posts ready on load", () => {
    const panel = renderPanel()
    expect(panel.posted).toEqual([{ type: "ready" }])
  })
})

describe("configuration lab webview — render", () => {
  it("populates the harness dropdown from snapshot adapters", () => {
    const panel = renderPanel()
    send(panel, snapshot())
    expect(optionsLength(panel, "harness")).toBe(3) // placeholder + 2 adapters
    expect(optionText(panel, "harness", 1)).toContain("Claude Code")
  })

  it("disables configuration selects until a harness is selected", () => {
    const panel = renderPanel()
    send(panel, snapshot())
    expect(isDisabled(panel, "model")).toBe(true)
    expect(isDisabled(panel, "posture")).toBe(true)
  })

  it("posts setHarness when a harness is picked", () => {
    const panel = renderPanel()
    send(panel, snapshot())
    panel.posted.length = 0
    select(panel, "harness", "codex")
    expect(panel.posted).toEqual([{ type: "setHarness", adapter: "codex" }])
  })

  it("renders the harness details when a harness is selected", () => {
    const panel = renderPanel()
    send(
      panel,
      snapshot({
        selection: { adapter: "claude-code" },
        harness: {
          slug: "claude-code",
          name: "Claude Code",
          version: "1.2.3",
          protocol: "acp",
          capabilities: { adapter: "claude-code", models: { defaultModel: "claude-sonnet-5" } },
        },
      }),
    )
    const details = el(panel, "harness-details")
    expect(details.innerHTML).toContain("v1.2.3")
    expect(details.innerHTML).toContain("Default model: claude-sonnet-5")
  })

  it("renders model/route/profile/posture/effort options", () => {
    const panel = renderPanel()
    send(
      panel,
      snapshot({
        selection: { adapter: "claude-code", model: "claude-opus-4-8" },
        axes: {
          models: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-5" }],
          routes: [{ value: "anthropic", label: "anthropic", runnable: true, curated: true, eligibleProfiles: [] }],
          profiles: [{ value: "anthropic-sub", label: "Anthropic Subscription" }],
          postures: [{ value: "plan", label: "plan (enforced)", enforcement: "enforced", restartRequired: false }],
          efforts: ["low", "medium", "high"],
        },
      }),
    )
    expect(optionsLength(panel, "model")).toBe(3)
    expect(isDisabled(panel, "route")).toBe(false)
    expect(optionsLength(panel, "posture")).toBe(2)
    expect(optionsLength(panel, "effort")).toBe(4)
  })

  it("posts setModel when a model is picked", () => {
    const panel = renderPanel()
    send(
      panel,
      snapshot({
        selection: { adapter: "claude-code" },
        axes: {
          models: [{ id: "claude-opus-4-8" }],
          routes: [],
          profiles: [],
          postures: [],
          efforts: [],
        },
      }),
    )
    panel.posted.length = 0
    select(panel, "model", "claude-opus-4-8")
    expect(panel.posted).toEqual([{ type: "setModel", model: "claude-opus-4-8" }])
  })

  it("renders effective config fields and badges", () => {
    const panel = renderPanel()
    send(
      panel,
      snapshot({
        selection: { adapter: "claude-code", model: "claude-opus-4-8" },
        effective: [
          { key: "Harness", value: "claude-code", source: "explicit" },
          { key: "Model", value: "claude-opus-4-8", source: "explicit" },
          { key: "Route / gateway", source: "unset" },
        ],
      }),
    )
    const effective = el(panel, "effective")
    expect(effective.innerHTML).toContain("claude-code")
    expect(effective.innerHTML).toContain("explicit")
    expect(effective.innerHTML).toContain("unset")
  })

  it("renders validation issues", () => {
    const panel = renderPanel()
    send(
      panel,
      snapshot({
        selection: { adapter: "claude-code" },
        issues: [{ severity: "error", axis: "profile", message: "No eligible profile" }],
      }),
    )
    const issues = el(panel, "issues")
    expect(issues.innerHTML).toContain("No eligible profile")
    expect(issuesSection(panel).hidden).toBe(false)
  })

  it("posts copyJson when Copy JSON is clicked", () => {
    const panel = renderPanel()
    send(panel, snapshot({ selection: { adapter: "claude-code" } }))
    panel.posted.length = 0
    click(panel, "btn-copy")
    expect(panel.posted).toEqual([{ type: "copyJson" }])
  })

  it("posts spawn when Spawn is clicked", () => {
    const panel = renderPanel()
    send(panel, snapshot({ selection: { adapter: "claude-code" } }))
    panel.posted.length = 0
    click(panel, "btn-spawn")
    expect(panel.posted).toEqual([{ type: "spawn" }])
  })
})

function issuesSection(panel: Panel): DomElement {
  return el(panel, "issues-section")
}
