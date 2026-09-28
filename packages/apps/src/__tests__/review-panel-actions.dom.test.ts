/**
 * Real-DOM coverage for the `agentproto_reviews` panel's action wiring —
 * same technique as config-edit.test.ts: the REAL bundled `REVIEW_PANEL_HTML`
 * loaded through jsdom with `runScripts: "dangerously"`, a fake
 * `window.McpApp` bridge standing in for the daemon so `panel-bridge.ts`
 * takes its standalone code path (no postMessage round trip to fake).
 *
 * Proof matrix item 7 (review-session-panel step, Goal B): every action
 * button calls the exact real tool name with the exact arguments the plan
 * specifies — Cancel -> review_cancel, Re-run fresh -> review_run with
 * {nocache:true, wait:false, supersede:true}, Fetch PR status -> review_pr
 * by runId, Export -> review_export. Never a second, invented write path.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import type { DomWindow } from "jsdom"
import { REVIEW_PANEL_HTML } from "../review-panel/panel.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }
interface ToolCall {
  tool: string
  args: Record<string, unknown>
}
type ToolHandler = (args: Record<string, unknown>) => ToolResult

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

const RUNNING_ROW = {
  runId: "review-live",
  status: "running",
  binding: "default",
  repoRemote: "github.com/acme/demo",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  createdAt: new Date().toISOString(),
  cwd: "/repo/demo",
  lanes: [],
}

function baseHandlers(): Record<string, ToolHandler> {
  return {
    review_ledger: () => ok({ total: 1, attestations: [RUNNING_ROW] }),
    review_status: () =>
      ok({ runId: "review-live", status: "running", binding: "default", lanes: [{ id: "ok", status: "pass" }] }),
    review_cancel: () => ok({ runId: "review-live", cancelled: true, status: "cancelled" }),
    review_run: () => ok({ runId: "review-live-2", status: "running" }),
    review_pr: () => ok({ ok: true, status: { state: "open" } }),
    review_export: () => ok({ path: "/tmp/review-live.json" }),
  }
}

const openWindows: DomWindow[] = []

function renderPanel(overrides: Record<string, ToolHandler> = {}) {
  const calls: ToolCall[] = []
  const handlers = { ...baseHandlers(), ...overrides }
  const dom = new JSDOM(REVIEW_PANEL_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, args: Record<string, unknown>) => {
              calls.push({ tool: name, args })
              const handler = handlers[name]
              if (!handler) return Promise.resolve({ content: [{ type: "text", text: "unknown tool" }], isError: true })
              return Promise.resolve(handler(args))
            },
            updateModelContext: () => Promise.resolve(),
            openLink: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, calls }
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function click(window: DomWindow, id: string): void {
  const el = window.document.getElementById(id)
  if (!el) throw new Error(`#${id} not found`)
  el.dispatchEvent(new window.Event("click"))
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
  vi.restoreAllMocks()
})

describe("agentproto_reviews panel — action wiring (real panel script, fake bridge)", () => {
  it("boots, lists the running row via review_ledger({includeRunning: true})", async () => {
    const { window, calls } = renderPanel()
    await settle()
    const listCall = calls.find(c => c.tool === "review_ledger")
    expect(listCall?.args).toEqual({ includeRunning: true })
    expect(window.document.getElementById("list-pane")?.innerHTML).toContain("review-live")
  })

  it("clicking a row calls review_status(runId) and opens the detail pane", async () => {
    const { window, calls } = renderPanel()
    await settle()
    const row = window.document.querySelector('tr[data-runid="review-live"]')
    expect(row).toBeTruthy()
    row!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    const statusCall = calls.find(c => c.tool === "review_status")
    expect(statusCall?.args).toEqual({ runId: "review-live" })
    expect(window.document.getElementById("detail-pane")?.classList.contains("open")).toBe(true)
  })

  it("Cancel calls review_cancel with exactly {runId}", async () => {
    const { window, calls } = renderPanel()
    await settle()
    window.document.querySelector('tr[data-runid="review-live"]')!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    click(window, "cancel-btn")
    await settle()
    const cancelCall = calls.find(c => c.tool === "review_cancel")
    expect(cancelCall?.args).toEqual({ runId: "review-live" })
  })

  it("Re-run fresh calls review_run with cwd + nocache:true, wait:false, supersede:true", async () => {
    const { window, calls } = renderPanel()
    await settle()
    window.document.querySelector('tr[data-runid="review-live"]')!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    click(window, "rerun-btn")
    await settle()
    const rerunCall = calls.find(c => c.tool === "review_run")
    expect(rerunCall?.args).toEqual({ cwd: "/repo/demo", binding: "default", nocache: true, wait: false, supersede: true })
  })

  it("Fetch PR status calls review_pr with exactly {runId}", async () => {
    const { window, calls } = renderPanel()
    await settle()
    window.document.querySelector('tr[data-runid="review-live"]')!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    click(window, "pr-btn")
    await settle()
    const prCall = calls.find(c => c.tool === "review_pr")
    expect(prCall?.args).toEqual({ runId: "review-live" })
  })

  it("Export calls review_export with exactly {runId}", async () => {
    const { window, calls } = renderPanel()
    await settle()
    window.document.querySelector('tr[data-runid="review-live"]')!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    click(window, "export-btn")
    await settle()
    const exportCall = calls.find(c => c.tool === "review_export")
    expect(exportCall?.args).toEqual({ runId: "review-live" })
  })
})
