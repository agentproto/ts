/**
 * Real-DOM coverage for the ops panel's Worktrees card — the built
 * `OPS_PANEL_HTML` through jsdom with a fake `window.McpApp` bridge (same
 * technique as store-panel.dom.test.ts).
 *
 * `worktree_gc` falls back to a background job after its 25 s default
 * `waitMs` and returns `{ jobId, status: "running" }`. On a repo with dozens
 * of worktrees the panel used to read that as an empty plan ("0 reclaim …
 * (no linked worktrees)"); it now polls `worktree_gc_status` until the real
 * plan lands.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import type { DomWindow } from "jsdom"
import { OPS_PANEL_HTML } from "../ops-panel/ui.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }
type AppToolHandler = (args: Record<string, unknown>) => unknown

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

type TestWindow = DomWindow & {
  McpApp: unknown
  MouseEvent: new (type: string, init?: { bubbles?: boolean }) => Event
}

const openWindows: DomWindow[] = []

/** Renders the panel; `app_tool_call`s route to `handlers[args.tool]`, any
 *  other app tool answers an empty list. Records every inner tool call. */
function renderPanel(handlers: Record<string, AppToolHandler>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const dom = new JSDOM(OPS_PANEL_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/apps/%40agentproto%2Fops-panel/ui",
    beforeParse(window) {
      const w = window as unknown as TestWindow
      w.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, input: { tool?: string; args?: Record<string, unknown> }) => {
              if (name !== "app_tool_call" || !input.tool) return Promise.resolve(ok([]))
              const args = input.args ?? {}
              calls.push({ tool: input.tool, args })
              const handler = handlers[input.tool]
              return Promise.resolve(handler ? (handler(args) as ToolResult) : ok([]))
            },
            updateModelContext: () => Promise.resolve(),
            openLink: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window as unknown as TestWindow, calls }
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function click(window: TestWindow, selector: string): void {
  const el = window.document.querySelector(selector)
  if (!el) throw new Error(`${selector} not found`)
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
}

const PLAN = {
  mode: "plan",
  plan: [
    { path: "/wt/a", class: "reclaim" },
    { path: "/wt/b", class: "reclaim" },
    { path: "/wt/c", class: "hold" },
  ],
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
  vi.restoreAllMocks()
})

describe("ops panel — worktree gc (real panel script, fake bridge)", () => {
  it("polls worktree_gc_status when worktree_gc falls back to the background, then renders the real plan", async () => {
    let statusPolls = 0
    const { window, calls } = renderPanel({
      worktree_gc: () => ok({ jobId: "wgc_1234abcd", status: "running", followUp: { pollAfterMs: 5 } }),
      worktree_gc_status: () => {
        statusPolls++
        return statusPolls < 2
          ? ok({ jobId: "wgc_1234abcd", status: "running", followUp: { pollAfterMs: 5 } })
          : ok({ jobId: "wgc_1234abcd", status: "done", result: PLAN })
      },
    })
    await settle()
    click(window, "#wt-dry")
    await settle(120)

    expect(calls.filter(c => c.tool === "worktree_gc_status").map(c => c.args)).toEqual([
      { jobId: "wgc_1234abcd" },
      { jobId: "wgc_1234abcd" },
    ])
    const text = window.document.getElementById("wt-plan")!.textContent
    expect(text).toContain("2 reclaim / 0 salvage / 1 hold")
    expect(text).not.toContain("no linked worktrees")
    expect((window.document.getElementById("wt-apply") as unknown as { disabled: boolean }).disabled).toBe(false)
  })

  it("renders an inline plan without polling", async () => {
    const { window, calls } = renderPanel({ worktree_gc: () => ok(PLAN) })
    await settle()
    click(window, "#wt-dry")
    await settle()
    expect(calls.some(c => c.tool === "worktree_gc_status")).toBe(false)
    expect(window.document.getElementById("wt-plan")!.textContent).toContain("2 reclaim / 0 salvage / 1 hold")
  })

  it("shows a failed background job as an error, not an empty plan", async () => {
    const { window } = renderPanel({
      worktree_gc: () => ok({ jobId: "wgc_1234abcd", status: "running", followUp: { pollAfterMs: 5 } }),
      worktree_gc_status: () => ok({ jobId: "wgc_1234abcd", status: "failed", error: "git exploded" }),
    })
    await settle()
    click(window, "#wt-dry")
    await settle()
    expect(window.document.getElementById("wt-plan")!.textContent).toBe("worktree_gc: git exploded")
  })
})
