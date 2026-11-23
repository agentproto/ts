/**
 * The config app's Models section read `catalog_models { full: true }` in
 * ONE unpaged call. The full catalog passes the daemon's MCP result cap, the
 * daemon replaces it with its `{ truncated }` marker, and
 * `(rr.data && rr.data.routes) || []` rendered "No models match". The
 * section now pages through `pageAll` (@agentproto/app-client/page-all).
 * Same jsdom + fake `window.McpApp` technique as config-capabilities.dom.test.ts.
 */
import type { DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { CONFIG_HTML } from "../config/ui.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }
type ToolHandler = (args: Record<string, unknown>) => ToolResult

const CAP = 100_000
const openWindows: DomWindow[] = []

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

/** 600 full catalog rows: ~180 KB unpaged, a few KB per page. */
const ROUTES = Array.from({ length: 600 }, (_, i) => ({
  vendor: `vendor-${String(i % 12).padStart(2, "0")}`,
  product: `model-${String(i).padStart(3, "0")}`,
  route: "openrouter",
  ref: `openrouter/model-${i}`,
  runnable: true,
  curated: false,
  multiModel: false,
  eligibleProfiles: ["openrouter-api"],
  adapters: ["opencode"],
  pricing: { inPer1M: 1, outPer1M: 2 },
  note: "x".repeat(120),
}))

/** The daemon's catalog_models: unpaged = `{ routes }`, limit/cursor = a
 *  page; a body over the cap becomes the marker, as an error result
 *  (current daemons) or a successful one (older daemons). */
function cappedCatalog(errorForm: boolean): ToolHandler {
  return args => {
    const limit = typeof args.limit === "number" ? args.limit : undefined
    const start = typeof args.cursor === "string" ? Number(args.cursor) : 0
    const body =
      limit === undefined
        ? { routes: ROUTES }
        : {
            items: ROUTES.slice(start, start + limit),
            total: ROUTES.length,
            ...(start + limit < ROUTES.length ? { nextCursor: String(start + limit) } : {}),
          }
    const text = JSON.stringify(body)
    if (text.length <= CAP) return ok(body)
    const marker = JSON.stringify({ truncated: true, totalBytes: text.length, hint: "use limit/cursor/fields" })
    return errorForm ? { content: [{ type: "text", text: marker }], isError: true } : ok(JSON.parse(marker))
  }
}

function renderModels(catalog: ToolHandler): { window: DomWindow; catalogArgs: Array<Record<string, unknown>> } {
  const catalogArgs: Array<Record<string, unknown>> = []
  const handlers: Record<string, ToolHandler> = {
    daemon_health: () => ok({ version: "1.2.3" }),
    auth_profile_list: () => ok({ profiles: [] }),
    config_get: () => ok({ keys: [], revision: "r1" }),
    catalog_models: args => {
      catalogArgs.push(args)
      return catalog(args)
    },
  }
  const dom = new JSDOM(CONFIG_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/#models",
    beforeParse(window) {
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, args: Record<string, unknown>) => {
              if (name !== "app_tool_call") return Promise.resolve(ok({}))
              const handler = handlers[String(args.tool)]
              if (!handler) {
                return Promise.resolve({ content: [{ type: "text", text: `unknown daemon tool: ${String(args.tool)}` }], isError: true })
              }
              // app_tool_call wraps the inner tool result once more.
              return Promise.resolve(ok(handler((args.args as Record<string, unknown>) ?? {})))
            },
            updateModelContext: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: dom.window, catalogArgs }
}

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

describe("config app: Models section over the MCP result cap", () => {
  it.each([
    ["successful marker", false],
    ["error marker", true],
  ])("pages catalog_models and renders every model instead of an empty catalog (%s)", async (_label, errorForm) => {
    const { window, catalogArgs } = renderModels(cappedCatalog(errorForm))
    await settle(200)
    const html = window.document.getElementById("sec-models")?.innerHTML ?? ""
    expect(html).not.toContain("No models match")
    expect(html).toContain("model-000")
    expect(html).toContain("model-599")
    expect(catalogArgs.length).toBeGreaterThan(1)
    expect(catalogArgs.every(a => typeof a.limit === "number" && a.full === true)).toBe(true)
  })
})
