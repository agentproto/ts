/**
 * Real-DOM coverage for the ops panel's Sandboxes section — the built
 * `OPS_PANEL_HTML` through jsdom with a fake `window.McpApp` bridge (same
 * technique as `ops-panel-worktree-gc.dom.test.ts`).
 *
 * Fail on main: there is no Sandboxes section, `OPS_PANEL_TOOLS` never
 * declares `sandbox_list`, and the panel never calls it. With a fake bridge
 * the section must render one read-only table across `computer` and `e2b`,
 * per-provider + fleet totals, and the overflow reason carried by the
 * spawning session's `sandboxProviderChoice` (the box was placed by `auto`'s
 * overflow, not requested there).
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import type { DomWindow } from "jsdom"
import { OPS_PANEL_HTML, OPS_PANEL_TOOLS } from "../ops-panel/ui.js"

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

async function settle(ms = 80): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const NOW = Date.now()
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()

const BOXES = [
  {
    id: "box-comp-1",
    provider: "computer",
    state: "running",
    tenantId: "acme",
    endUser: "u1",
    host: "host-a",
    cpus: 4,
    memoryMiB: 8192,
    createdAt: iso(180),
    sessions: 1,
  },
  {
    id: "box-e2b-1",
    provider: "e2b",
    state: "running",
    cpus: 2,
    memoryMiB: 4096,
    createdAt: iso(30),
    sessions: 1,
  },
]

const USAGE = [
  {
    computer: "box-comp-1",
    tenantId: "acme",
    provider: "computer",
    from: iso(120),
    to: iso(60),
    activeSec: 3600,
    vcpuSec: 14400,
    gibSec: 28800,
    costEur: 1.25,
    eventId: "w1",
  },
  {
    computer: "box-e2b-1",
    tenantId: "acme",
    provider: "e2b",
    from: iso(30),
    to: iso(0),
    activeSec: 600,
    vcpuSec: 1200,
    gibSec: 2400,
    costEur: 0.25,
    eventId: "w2",
  },
]

const TOTALS = {
  activeSec: 4200,
  vcpuSec: 15600,
  gibSec: 31200,
  costEur: 1.5,
  costPartial: false,
}

/** A full session descriptor row: compact rows drop `sandboxId` and
 *  `sandboxProviderChoice`, so the panel asks for `full: true`. */
const SESSIONS = [
  {
    id: "sess-overflow",
    label: "worker",
    status: "running",
    startedAt: iso(30),
    sandboxId: "box-e2b-1",
    sandboxProvider: "e2b",
    sandboxProviderChoice: {
      requested: "auto",
      provider: "e2b",
      from: "computer",
      reason: "host capacity",
      at: iso(30),
    },
  },
]

function sandboxHandlers(): Record<string, AppToolHandler> {
  return {
    session_list: () => ok({ items: SESSIONS }),
    cron_list: () => ok([]),
    sandbox_list: () => ok({ boxes: BOXES, usage: USAGE, totals: TOTALS, errors: [], notScanned: [] }),
  }
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
  vi.restoreAllMocks()
})

describe("ops panel — sandboxes (real panel script, fake bridge)", () => {
  it("renders a Sandboxes section and calls sandbox_list", async () => {
    const { window, calls } = renderPanel(sandboxHandlers())
    await settle()

    expect(window.document.querySelectorAll("h2")).toHaveLength(5)
    const headings = Array.from(window.document.querySelectorAll("h2")).map(h => h.textContent).join(" ")
    expect(headings).toContain("Sandboxes")
    expect(window.document.getElementById("sandboxes")).not.toBeNull()
    expect(calls.some(c => c.tool === "sandbox_list")).toBe(true)
    expect(calls.find(c => c.tool === "sandbox_list")!.args).toMatchObject({ includeUsage: true })
  })

  it("renders both providers, per-provider + fleet totals, and the overflow reason", async () => {
    const { window } = renderPanel(sandboxHandlers())
    await settle()

    const table = window.document.getElementById("sandboxes")!.textContent ?? ""
    expect(table).toContain("computer")
    expect(table).toContain("e2b")
    expect(table).toContain("box-comp-1")
    expect(table).toContain("box-e2b-1")
    expect(table).toContain("4 vCPU / 8 GiB")
    expect(table).toContain("2 vCPU / 4 GiB")
    expect(table).toContain("host capacity")
    expect(table).toContain("est.")

    const totals = window.document.getElementById("sandbox-totals")!.textContent ?? ""
    expect(totals).toContain("All providers")
    expect(totals).toContain("2 boxes")
    expect(totals).toContain("\u20ac1.50")

    expect(window.document.getElementById("sandbox-count")!.textContent).toBe("2 boxes")
    // Read-only: the section offers no destructive action.
    expect(window.document.querySelectorAll("#sandboxes button").length).toBe(0)
  })

  it("filters the table by provider", async () => {
    const { window } = renderPanel(sandboxHandlers())
    await settle()

    const select = window.document.getElementById("sandbox-provider")!
    ;(select as unknown as { value: string }).value = "e2b"
    select.dispatchEvent(new window.MouseEvent("change", { bubbles: true }))

    const table = window.document.getElementById("sandboxes")!.textContent ?? ""
    expect(table).toContain("box-e2b-1")
    expect(table).not.toContain("box-comp-1")
  })

  it("keeps every OPS_PANEL_TOOLS entry a registered daemon tool (app validate mirror)", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const generated = join(here, "..", "..", "..", "runtime", "src", "daemon-tool-names.generated.ts")
    const names = [...readFileSync(generated, "utf8").matchAll(/^\s*"([^"]+)",\s*$/gm)].map(m => m[1]!)
    expect(names).toContain("sandbox_list")
    for (const tool of OPS_PANEL_TOOLS) {
      if (tool.startsWith("app_")) continue
      expect(names, `${tool} must be a daemon tool`).toContain(tool)
    }
  })
})
