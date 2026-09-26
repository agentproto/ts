/**
 * registerMcpApps — the resource/tool wiring every MCP-Apps host sees. A
 * fake McpServer captures the registrations; no transport needed.
 */
import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { isValidAppEmbedToken } from "../embed-tokens.js"
import type { AgnoMcpApp } from "@agentproto/apps"

function fakeServer() {
  const calls: {
    resources: Array<{ uri: string; options: Record<string, unknown>; handler: () => unknown }>
    tools: Array<{ name: string; options: Record<string, unknown> }>
  } = { resources: [], tools: [] }
  const server = {
    registerResource: (
      _name: string,
      uri: string,
      options: Record<string, unknown>,
      handler: () => unknown,
    ) => {
      calls.resources.push({ uri, options, handler })
    },
    registerTool: (_name: string, options: Record<string, unknown>) => {
      calls.tools.push({ name: _name, options })
    },
  }
  return { server: server as unknown as McpServer, calls }
}

function app(overrides: Partial<AgnoMcpApp>): AgnoMcpApp {
  return {
    id: "test_panel",
    title: "Test Panel",
    description: "test",
    inputSchema: { shape: {} },
    html: () => "<html>plain panel</html>",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as AgnoMcpApp<any, any>
}

describe("registerMcpApps", () => {
  it("bakes a valid per-boot embed token over the placeholder", async () => {
    const { server, calls } = fakeServer()
    registerMcpApps(server, [
      app({
        html: () =>
          '<script>window.__AGENPROTO_EMBED_TOKEN__ = "__AGENPROTO_EMBED_TOKEN__";</script>',
      }),
    ])
    const read = await calls.resources[0]!.handler()
    const text = (read as { contents: Array<{ text: string }> }).contents[0]!.text
    expect(text).not.toContain('"__AGENPROTO_EMBED_TOKEN__"')
    const match = text.match(/__AGENPROTO_EMBED_TOKEN__ = "([^"]+)"/)
    expect(match).not.toBeNull()
    expect(isValidAppEmbedToken(match![1])).toBe(true)
  })

  it("leaves panels without the placeholder byte-identical", async () => {
    const { server, calls } = fakeServer()
    registerMcpApps(server, [app({})])
    const read = await calls.resources[0]!.handler()
    const text = (read as { contents: Array<{ text: string }> }).contents[0]!.text
    expect(text).toBe("<html>plain panel</html>")
  })

  it("keeps the tool linked to the resource via _meta.ui.resourceUri", () => {
    const { server, calls } = fakeServer()
    registerMcpApps(server, [app({})])
    const meta = (calls.tools[0]!.options._meta ?? {}) as {
      ui?: { resourceUri?: string }
    }
    expect(meta.ui?.resourceUri).toBe("ui://test_panel/view")
  })
})
