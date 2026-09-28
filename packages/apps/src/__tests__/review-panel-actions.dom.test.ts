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
 *
 * Also covers the reviewer-session deep link: clicking an agent lane's
 * `.sess-link` button opens `/apps/@agentproto/live-session/ui?sessionId=…`
 * (ui/render.ts's `liveSessionUrl`) — a real per-session URL, never a bare
 * link to the session-less live-session panel.
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

const DONE_ROW = {
  runId: "review-done",
  verdict: "pass",
  binding: "default",
  repoRemote: "github.com/acme/demo",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  createdAt: new Date().toISOString(),
  lanes: [{ id: "correctness", status: "pass", blocking: true }],
}

function baseHandlers(): Record<string, ToolHandler> {
  return {
    review_ledger: () => ok({ total: 2, attestations: [RUNNING_ROW, DONE_ROW] }),
    review_status: args => {
      if (args.runId === "review-done") {
        return ok({
          runId: "review-done",
          status: "done",
          verdict: "pass",
          binding: "default",
          attestation: {
            target: { repoRemote: "github.com/acme/demo", baseSha: "b".repeat(40), headSha: "h".repeat(40) },
            lanes: [
              {
                id: "correctness",
                kind: "agent",
                status: "pass",
                blocking: true,
                findings: [],
                sessionId: "sess_reviewer",
              },
            ],
            rubrics: [],
            createdAt: new Date().toISOString(),
          },
        })
      }
      return ok({ runId: "review-live", status: "running", binding: "default", lanes: [{ id: "ok", status: "pass" }] })
    },
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

  it("clicking an agent lane's reviewer-session link opens the live-session widget deep-linked to exactly that session", async () => {
    const { window } = renderPanel()
    await settle()
    window.document.querySelector('tr[data-runid="review-done"]')!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    const sessLink = window.document.querySelector(".sess-link")
    expect(sessLink).toBeTruthy()
    expect(sessLink!.getAttribute("data-session-id")).toBe("sess_reviewer")
    // The standalone bridge (window.McpApp, used here) never populates
    // hostCapabilities.openLinks (panel-bridge.ts's initBridge only does
    // that over the real postMessage handshake), so openSession always
    // takes the window.open fallback in this test environment.
    const opened: Array<[string, string | undefined]> = []
    window.open = (url: string, target?: string) => {
      opened.push([url, target])
      return null
    }
    sessLink!.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(opened).toEqual([["https://example.test/apps/@agentproto/live-session/ui?sessionId=sess_reviewer", "_blank"]])
  })
})
