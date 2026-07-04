/**
 * MCP protocol validation for the sessions panel McpApp.
 * Exercises tools/list, tools/call agentproto_sessions, and resources/read.
 *
 * Runs fully in-process — no daemon needed.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { makeSessionsPanelApp } from "../sessions-panel-app.js"

function makeMockServer() {
  const server = new McpServer({
    name: "test-sessions",
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
    makeSessionsPanelApp({
      listSessions: (filter) => {
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

describe("sessions panel McpApp — MCP protocol", () => {
  it("tools/list: includes agentproto_sessions with _meta.ui.resourceUri", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.listTools()
    const tool = result.tools.find(t => t.name === "agentproto_sessions")

    expect(tool).toBeDefined()
    expect(tool?.description).toContain("sessions panel")
    // @ts-expect-error — _meta is non-standard but present in protocol
    expect(tool?._meta?.ui?.resourceUri).toBe("ui://agentproto_sessions/view")

    await client.close()
  })

  it("tools/call agentproto_sessions returns sessions snapshot", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "agentproto_sessions",
      arguments: {},
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]!
    const data = JSON.parse(content0.text) as { sessions: unknown[] }
    expect(Array.isArray(data.sessions)).toBe(true)
    expect(data.sessions).toHaveLength(2)

    await client.close()
  })

  it("tools/call agentproto_sessions with filter=running returns only alive sessions", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "agentproto_sessions",
      arguments: { filter: "running" },
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]!
    const data = JSON.parse(content0.text) as { sessions: Array<{ status: string }> }
    expect(data.sessions.every(s => s.status === "running")).toBe(true)

    await client.close()
  })

  it("resources/read ui://agentproto_sessions/view returns HTML panel", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.readResource({
      uri: "ui://agentproto_sessions/view",
    })

    const content = result.contents[0]!
    expect(content.mimeType).toBe("text/html;profile=mcp-app")
    if (!("text" in content)) throw new Error("expected text resource")
    expect(content.text).toContain("<!DOCTYPE html>")
    expect(content.text).toContain("agentproto sessions")
    // Bridge protocol must be present
    expect(content.text).toContain("ui/initialize")
    // Spec 2026-01-26: ui/initialize params REQUIRE `appInfo` — hosts
    // (ext-apps McpUiInitializeRequestSchema) reject/drop `clientInfo`,
    // leaving the panel blank. Guard the handshake shape.
    expect(content.text).toContain("appInfo")
    expect(content.text).not.toContain("clientInfo")

    await client.close()
  })

  it("resources/list includes ui://agentproto_sessions/view", async () => {
    const server = makeMockServer()
    const client = await makeClient(server)

    const result = await client.listResources()
    const resource = result.resources.find(
      r => r.uri === "ui://agentproto_sessions/view",
    )

    expect(resource).toBeDefined()
    expect(resource?.mimeType).toBe("text/html;profile=mcp-app")

    await client.close()
  })
})
