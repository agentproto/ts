// @vitest-environment jsdom
/**
 * Real-DOM coverage for the standalone-mode fix in packages/apps
 * panel-bridge.ts: `GET /apps/:appId/ui` (packages/runtime http-server.ts)
 * serves a builtin panel with the daemon's `window.McpApp` standalone shim
 * injected (`injectStandaloneAppBridge`, app-ui-apps.ts) but NO postMessage
 * host on the other end — before the fix, panel-bridge.ts never consumed
 * `window.McpApp` and every builtin panel hung forever on "Connecting to
 * bridge…" (confirmed against the live daemon at 127.0.0.1:18790).
 *
 * This loads the REAL `WORK_BOARD_HTML` (unmodified — this suite must not
 * touch packages/apps/src/work-board/, another session owns that panel's
 * rewrite) through jsdom with `runScripts: "dangerously"`, stands a fake
 * `window.McpApp` in for the daemon's real REST shim (that shim's own
 * fetch-based `callTool` is covered by packages/runtime's
 * app-ui-apps.test.ts; this suite is about whether panel-bridge.ts's
 * `initBridge()`/`callTool()` actually USE it), and asserts the board
 * leaves the "Connecting to bridge…" placeholder and renders real columns.
 *
 * The postMessage-host path (real MCP-Apps hosts, and this same package's
 * srcdoc relay — see appPanelController.ts) is untouched by the fix and
 * stays covered by packages/apps' panel-scripts.test.ts (handshake shape)
 * and this package's appPanelController.test.ts (host-side dispatch); it
 * isn't re-verified here.
 */
import type { DomDocument, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { WORK_BOARD_HTML } from "@agentproto/apps/work-board/panel"

interface TaskFixture {
  taskId: string
  boardId: string
  title: string
  status: string
  owner?: string
  rev: number
}

interface ToolCall {
  name: string
  args: Record<string, string | number | boolean | null | undefined>
}

interface Panel {
  window: DomWindow
  document: DomDocument
  calls: ToolCall[]
}

const openWindows: DomWindow[] = []

function renderStandalonePanel(tasks: TaskFixture[]): Panel {
  const calls: ToolCall[] = []
  const dom = new JSDOM(WORK_BOARD_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      // Stands in for `injectStandaloneAppBridge`'s real window.McpApp: a
      // top-level tab with no chat host, only the daemon's REST shim.
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name, args) => {
              calls.push({ name, args })
              if (name === "task_list") {
                return Promise.resolve({
                  content: [{ type: "text", text: JSON.stringify({ boardId: "ws:default", tasks }) }],
                })
              }
              return Promise.resolve({ content: [{ type: "text", text: "{}" }] })
            },
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, document: dom.window.document, calls }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

async function settle(): Promise<void> {
  // Lets the initBridge().then(loadBoard) promise chain (window.McpApp.connect
  // → callTool → render) drain past a real jsdom "Connecting to bridge…" boot.
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe("builtin panel over standalone HTTP (window.McpApp, no postMessage host)", () => {
  it('leaves "Connecting to bridge…" and renders a card per task once window.McpApp answers', async () => {
    const panel = renderStandalonePanel([
      { taskId: "task_1", boardId: "ws:default", title: "Ship it", status: "pending", rev: 0 },
      { taskId: "task_2", boardId: "ws:default", title: "Review PR", status: "in_progress", owner: "alice", rev: 1 },
    ])
    const statusbar = panel.document.getElementById("statusbar")
    if (!statusbar) throw new Error("#statusbar missing from WORK_BOARD_HTML")
    expect(statusbar.textContent).toBe("Connecting to bridge…")

    await settle()

    expect(statusbar.textContent).not.toBe("Connecting to bridge…")
    expect(statusbar.textContent).toContain("2 tasks")

    const columns = panel.document.getElementById("columns")
    if (!columns) throw new Error("#columns missing from WORK_BOARD_HTML")
    expect([...columns.querySelectorAll(".card")]).toHaveLength(2)
    expect(columns.innerHTML).toContain("Ship it")
    expect(columns.innerHTML).toContain("Review PR")
  })

  it("calls task_list through window.McpApp.connect(), not postMessage", async () => {
    const panel = renderStandalonePanel([])
    await settle()
    expect(panel.calls.map(c => c.name)).toContain("task_list")
  })

  it("keeps the display-mode toggle buttons hidden — no host to advertise a mode", async () => {
    const panel = renderStandalonePanel([])
    await settle()

    const dm = panel.document.getElementById("agentproto-display-mode")
    const pin = panel.document.getElementById("agentproto-display-mode-pip")
    if (!dm || !pin) throw new Error("display-mode toggle buttons missing from WORK_BOARD_HTML")
    expect(dm.getAttribute("style")).toMatch(/display:\s*none/)
    expect(pin.getAttribute("style")).toMatch(/display:\s*none/)
  })
})
