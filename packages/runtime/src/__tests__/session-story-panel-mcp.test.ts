/**
 * MCP protocol validation for the session story panel McpApp.
 * Exercises tools/list, tools/call agentproto_session_story, and
 * resources/read. Mirrors sessions-panel-mcp.test.ts.
 *
 * Runs fully in-process — no daemon needed.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { makeSessionStoryPanelApp } from "../session-story-panel-app.js"

function makeMockServer() {
  const server = new McpServer({
    name: "test-session-story",
    version: "0.0.1",
  })

  const mockSessions = [
    {
      id: "sess-001",
      kind: "agent-cli" as const,
      workspaceSlug: "default",
      command: "claude-code",
      pid: 1234,
      status: "running" as const,
      startedAt: "2026-06-21T10:00:00.000Z",
    },
    {
      id: "sess-002",
      kind: "terminal" as const,
      workspaceSlug: "default",
      command: "bash",
      pid: null,
      status: "exited" as const,
      startedAt: "2026-06-21T09:00:00.000Z",
      exitCode: 0,
    },
  ]

  registerMcpApps(server, [
    makeSessionStoryPanelApp({
      listSessions: filter => {
        if (filter === "running") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return mockSessions.filter(s => s.status === "running") as any
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return mockSessions as any
      },
    }),
  ])

  return server
}

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("session story panel McpApp — MCP protocol", () => {
  it("tools/list: includes agentproto_session_story with _meta.ui.resourceUri", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.listTools()
    const tool = result.tools.find(t => t.name === "agentproto_session_story")

    expect(tool).toBeDefined()
    expect(tool?.description).toContain("session story panel")
    // @ts-expect-error — _meta is non-standard but present in protocol
    expect(tool?._meta?.ui?.resourceUri).toBe("ui://agentproto_session_story/view")

    await client.close()
  })

  it("tools/call agentproto_session_story returns a sessions snapshot", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "agentproto_session_story",
      arguments: {},
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]!
    const data = JSON.parse(content0.text) as { sessions: unknown[]; sessionId?: string }
    expect(Array.isArray(data.sessions)).toBe(true)
    expect(data.sessions).toHaveLength(2)
    expect(data.sessionId).toBeUndefined()

    await client.close()
  })

  it("tools/call agentproto_session_story echoes back the requested sessionId", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "agentproto_session_story",
      arguments: { sessionId: "sess-001" },
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]!
    const data = JSON.parse(content0.text) as { sessions: unknown[]; sessionId?: string }
    expect(data.sessionId).toBe("sess-001")

    await client.close()
  })

  it("resources/read ui://agentproto_session_story/view returns HTML panel", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.readResource({
      uri: "ui://agentproto_session_story/view",
    })

    const content = result.contents[0]!
    expect(content.mimeType).toBe("text/html;profile=mcp-app")
    if (!("text" in content)) throw new Error("expected text resource")
    expect(content.text).toContain("<!doctype html>")
    expect(content.text).toContain("session story")
    // Bridge protocol must be present
    expect(content.text).toContain("ui/initialize")
    // Live data wiring must be present
    expect(content.text).toContain("session_list")
    expect(content.text).toContain("agent_export")
    expect(content.text).toContain("agent_prompt")

    await client.close()
  })

  it("resources/list includes ui://agentproto_session_story/view", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.listResources()
    const resource = result.resources.find(
      r => r.uri === "ui://agentproto_session_story/view",
    )

    expect(resource).toBeDefined()
    expect(resource?.mimeType).toBe("text/html;profile=mcp-app")

    await client.close()
  })
})
