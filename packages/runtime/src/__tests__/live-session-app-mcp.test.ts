/**
 * MCP protocol coverage for the live-session app and its agent_start binding.
 * Runs in-process so tool/resource metadata is checked exactly as a host sees it.
 */

import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerAgentTools } from "../agent-tools.js"
import { registerAppPullTools } from "../app-pull-tools.js"
import { makeLiveSessionApp } from "@agentproto/apps"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { createSessionsRegistry } from "../sessions.js"

async function setup() {
  const registry = createSessionsRegistry({ persist: false })
  const server = new McpServer({ name: "live-session-test", version: "0.0.1" })
  registerAgentTools(server, { registry })
  registerAppPullTools(server, { registry })
  registerMcpApps(server, [
    makeLiveSessionApp({ httpBaseUrl: "http://127.0.0.1:19999" }),
  ])

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "live-session-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

function uiMeta(tool: { _meta?: Record<string, unknown> } | undefined) {
  return tool?._meta?.ui as
    | { resourceUri?: string; visibility?: string[] }
    | undefined
}

describe("live-session app — MCP protocol", () => {
  it("exposes the app resource and binds agent_start to it", async () => {
    const client = await setup()
    const { tools } = await client.listTools()

    expect(uiMeta(tools.find(tool => tool.name === "live_session"))).toEqual({
      resourceUri: "ui://live_session/view",
      visibility: ["model", "app"],
    })
    expect(uiMeta(tools.find(tool => tool.name === "agent_start"))).toEqual({
      resourceUri: "ui://live_session/view",
      visibility: ["model", "app"],
    })
    expect(uiMeta(tools.find(tool => tool.name === "app_session_tree"))).toEqual({
      visibility: ["app"],
    })
    expect(uiMeta(tools.find(tool => tool.name === "app_session_events"))).toEqual({
      visibility: ["app"],
    })

    await client.close()
  })

  it("returns the requested session recipe from the standalone tool", async () => {
    const client = await setup()
    const result = await client.callTool({
      name: "live_session",
      arguments: { sessionId: "sess-test" },
    })
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text

    expect(JSON.parse(text ?? "{}")).toEqual({
      sessionId: "sess-test",
      httpBaseUrl: "http://127.0.0.1:19999",
    })
    await client.close()
  })

  it("serves a spec-correct, live-wired HTML resource", async () => {
    const client = await setup()
    const result = await client.readResource({ uri: "ui://live_session/view" })
    const content = result.contents[0]
    if (!content || !("text" in content)) throw new Error("expected text resource")

    expect(content.mimeType).toBe("text/html;profile=mcp-app")
    expect(content.text).toContain("appInfo")
    expect(content.text).not.toContain("clientInfo")
    expect(content.text).toContain("app_session_tree")
    expect(content.text).toContain("app_session_events")
    expect(content.text).toContain("/events/stream")
    expect(content.text).toContain("ui/request-display-mode")
    // The widget must pin itself to the session named by the tool result
    // that mounted it (agent_start's descriptor) — not self-discover the
    // newest running session for every card.
    expect(content.text).toContain("ui/notifications/tool-result")
    expect(content.text).toContain("extractToolResultSessionId")

    await client.close()
  })
})
