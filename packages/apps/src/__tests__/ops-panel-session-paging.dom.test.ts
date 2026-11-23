/**
 * The ops panel pages `session_list { full: true, limit: 100 }`. A page of
 * 100 FULL session records can pass the daemon's MCP result cap; the daemon
 * then replaces the page with its `{ truncated }` marker and the old walk
 * read it as "no sessions". The walk now halves a capped page
 * (`pageAll`, @agentproto/app-client/page-all). Same jsdom + fake bridge
 * technique as ops-panel-sandboxes.dom.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest"
import { JSDOM } from "jsdom"
import type { DomWindow } from "jsdom"
import { OPS_PANEL_HTML } from "../ops-panel/ui.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }

const CAP = 100_000
const openWindows: DomWindow[] = []

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

const SESSIONS = Array.from({ length: 150 }, (_, i) => ({
  id: `sess_${String(i).padStart(3, "0")}`,
  kind: "agent-cli",
  status: "exited",
  label: `session ${i}`,
  startedAt: new Date(Date.now() - i * 60_000).toISOString(),
  note: "x".repeat(1_400),
}))

function cappedSessionList(errorForm: boolean) {
  return (args: Record<string, unknown>): ToolResult => {
    const limit = typeof args.limit === "number" ? args.limit : 50
    const start = typeof args.cursor === "string" ? Number(args.cursor) : 0
    const end = start + limit
    const body = { items: SESSIONS.slice(start, end), total: SESSIONS.length, ...(end < SESSIONS.length ? { nextCursor: String(end) } : {}) }
    const text = JSON.stringify(body)
    if (text.length <= CAP) return ok(body)
    const marker = JSON.stringify({ truncated: true, totalBytes: text.length, hint: "use limit/cursor/fields" })
    return errorForm ? { content: [{ type: "text", text: marker }], isError: true } : ok(JSON.parse(marker))
  }
}

function renderPanel(sessionList: (args: Record<string, unknown>) => ToolResult) {
  const limits: unknown[] = []
  const dom = new JSDOM(OPS_PANEL_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/apps/%40agentproto%2Fops-panel/ui",
    beforeParse(window) {
      ;(window as unknown as { McpApp: unknown }).McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, input: { tool?: string; args?: Record<string, unknown> }) => {
              if (name !== "app_tool_call" || input.tool !== "session_list") return Promise.resolve(ok([]))
              limits.push(input.args?.limit)
              return Promise.resolve(sessionList(input.args ?? {}))
            },
            updateModelContext: () => Promise.resolve(),
            openLink: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, limits }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

describe("ops panel: session_list pages over the MCP result cap", () => {
  it.each([
    ["successful marker", false],
    ["error marker", true],
  ])("halves a capped page and lists every session instead of none (%s)", async (_label, errorForm) => {
    const { window, limits } = renderPanel(cappedSessionList(errorForm))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(window.document.getElementById("sess-count")?.textContent).toContain("150 shown")
    expect(limits[0]).toBe(100)
    expect(limits).toContain(50)
  })
})
