/**
 * Real-DOM coverage for the config app's Capabilities section (PLAN C):
 * the panel is loaded through jsdom with `runScripts: "dangerously"` and a
 * fake `window.McpApp` bridge stands in for the daemon — same pattern as
 * `config-edit.test.ts`. Covers both tabs (MCP / Skills) and the two write
 * flows (`mcp_import`, `mcp_imported_remove`) behind the two-click confirm.
 */
import type { DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { CONFIG_HTML } from "../config/ui.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }
type ToolHandler = (args: Record<string, unknown>) => ToolResult
interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

const openWindows: DomWindow[] = []

const INVENTORY = {
  mcp: {
    imported: [
      {
        id: "claude-code:global:chrome-devtools",
        alias: "chrome-devtools",
        name: "chrome-devtools",
        type: "stdio",
        source: "claude-code",
        status: "connected",
        toolCount: 4,
        usedBySessions: ["sess-1"],
      },
    ],
    discovered: [
      {
        id: "claude-code:global:chrome-devtools",
        source: "claude-code",
        scope: "global",
        name: "chrome-devtools",
        type: "stdio",
        imported: true,
      },
      {
        id: "cursor:global:goose-bridge",
        source: "cursor",
        scope: "global",
        name: "goose-bridge",
        type: "http",
        imported: false,
      },
    ],
    daemonMountByHarness: { hermes: "default", "claude-code": "default", codex: "on-request" },
  },
  skills: {
    packs: [{ name: "agentproto", version: "1.0.0", path: "/packs/agentproto", skills: ["review", "deploy"] }],
    byHarness: [
      {
        adapter: "hermes",
        target: { format: "flat-dir", dir: "~/.hermes/skills" },
        installed: ["review"],
        native: [],
        spawnOption: true,
      },
      {
        adapter: "claude-code",
        target: { format: "claude-plugin", dir: "~/.claude/plugins/agentproto", unit: "whole-pack" },
        installed: [],
        native: ["deploy"],
        spawnOption: false,
      },
      {
        adapter: "codex",
        installed: [],
        native: [],
        spawnOption: false,
      },
    ],
    defaults: { global: ["review"], byAdapter: {} },
  },
}

function renderPanel(overrides: Record<string, ToolHandler>): {
  window: DomWindow
  calls: ToolCall[]
} {
  const calls: ToolCall[] = []
  const handlers: Record<string, ToolHandler> = {
    daemon_health: () => ok({ version: "1.2.3" }),
    capabilities_inventory: () => ok(INVENTORY),
    ...overrides,
  }
  const dom = new JSDOM(CONFIG_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/#capabilities",
    beforeParse(window) {
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, args: Record<string, unknown>) => {
              if (name !== "app_tool_call") return Promise.resolve(ok({}))
              const tool = String(args.tool)
              const toolArgs = (args.args as Record<string, unknown>) ?? {}
              calls.push({ tool, args: toolArgs })
              const handler = handlers[tool]
              if (!handler) return Promise.resolve(fail(`unknown daemon tool: ${tool}`))
              return Promise.resolve(handler(toolArgs))
            },
            updateModelContext: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, calls }
}

async function settle(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function el(window: DomWindow, id: string): DomElement {
  const found = window.document.getElementById(id)
  if (!found) throw new Error(`#${id} not found in rendered panel`)
  return found
}

function click(window: DomWindow, node: DomElement): void {
  node.dispatchEvent(new window.Event("click"))
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

describe("config app — Capabilities section", () => {
  it("renders the imported MCP table with status/tool-count/used-by on the MCP tab", async () => {
    const panel = renderPanel({})
    await settle(80)

    const html = el(panel.window, "sec-capabilities").innerHTML
    expect(html).toContain("chrome-devtools")
    expect(html).toContain("connected")
    expect(html).toContain("used by 1 session")
    expect(html).toContain("goose-bridge") // discovered, not imported
  })

  it("switches to the Skills tab and renders the matrix (installed/native/unsupported)", async () => {
    const panel = renderPanel({})
    await settle(80)

    const tabBtn = panel.window.document.querySelector('[data-cap-tab="skills"]') as DomElement | null
    expect(tabBtn).toBeTruthy()
    click(panel.window, tabBtn!)
    await settle(30)

    const html = el(panel.window, "sec-capabilities").innerHTML
    expect(html).toContain("hermes")
    expect(html).toContain("claude-code")
    expect(html).toContain("installed")
    expect(html).toContain("native")
    expect(html).toContain("unsupported") // codex declares no metadata.skills
    expect(html).toContain("agentproto"); // pack name
  })

  it("imports a discovered MCP after the two-click confirm", async () => {
    let imported: Record<string, unknown> | undefined
    const panel = renderPanel({
      mcp_import: args => {
        imported = args
        return ok({ id: args.sourceMcpId, alias: "goose-bridge" })
      },
    })
    await settle(80)

    const btn = panel.window.document.querySelector(
      '[data-cap-import="cursor:global:goose-bridge"]',
    ) as DomElement | null
    expect(btn).toBeTruthy()
    click(panel.window, btn!) // arm
    click(panel.window, btn!) // confirm
    await settle(30)

    expect(imported).toEqual({ sourceMcpId: "cursor:global:goose-bridge" })
  })

  it("removes an imported MCP after the two-click confirm", async () => {
    let removedId: unknown
    const panel = renderPanel({
      mcp_imported_remove: args => {
        removedId = args.id
        return ok({ ok: true, id: args.id })
      },
    })
    await settle(80)

    const btn = panel.window.document.querySelector(
      '[data-cap-import-remove="claude-code:global:chrome-devtools"]',
    ) as DomElement | null
    expect(btn).toBeTruthy()
    click(panel.window, btn!) // arm
    click(panel.window, btn!) // confirm
    await settle(30)

    expect(removedId).toBe("claude-code:global:chrome-devtools")
  })

  it("lazily loads tool names via mcp_imported_tool_list on 'show tools'", async () => {
    const panel = renderPanel({
      mcp_imported_tool_list: () => ok({ tools: [{ name: "take_screenshot", description: "Capture the page" }] }),
    })
    await settle(80)

    const btn = panel.window.document.querySelector(
      '[data-cap-import-tools="claude-code:global:chrome-devtools"]',
    ) as DomElement | null
    expect(btn).toBeTruthy()
    click(panel.window, btn!)
    await settle(30)

    const html = el(panel.window, "sec-capabilities").innerHTML
    expect(html).toContain("take_screenshot")
    expect(html).toContain("Capture the page")
  })

  it("shows a muted feature-detect note on a pre-upgrade daemon (unknown tool)", async () => {
    const panel = renderPanel({
      capabilities_inventory: () => fail("unknown daemon tool: capabilities_inventory"),
    })
    await settle(80)

    const html = el(panel.window, "sec-capabilities").innerHTML
    expect(html).toContain("needs a newer agentproto daemon")
  })
})
