/**
 * Regression guard for the boot-time mount (builtin-apps.ts): the
 * daemon-builtin panels that moved to @agentproto/apps must register their
 * exact same tool ids + ui:// resourceUris on a fresh McpServer with zero
 * installed apps — no `app_install` step required. This is the contract
 * the move promised: clients see a byte-identical public surface.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { makeBuiltinPanelApps } from "../builtin-apps.js"

const EXPECTED = [
  { toolId: "agentproto_sessions", resourceUri: "ui://agentproto_sessions/view" },
  { toolId: "agentproto_agents_overview", resourceUri: "ui://agentproto_agents_overview/view" },
  { toolId: "agentproto_bureau_sessions", resourceUri: "ui://agentproto_bureau_sessions/view" },
  { toolId: "agentproto_session_story", resourceUri: "ui://agentproto_session_story/view" },
  { toolId: "live_session", resourceUri: "ui://live_session/view" },
  { toolId: "agentproto_session_chat", resourceUri: "ui://agentproto_session_chat/view" },
  { toolId: "agentproto_work_board", resourceUri: "ui://agentproto_work_board/view" },
]

async function setup() {
  const server = new McpServer({ name: "builtin-apps-test", version: "0.0.1" })
  registerMcpApps(
    server,
    makeBuiltinPanelApps({
      listSessions: () => [],
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => false,
      listTasks: (boardId) => ({ boardId: boardId ?? "ws:default", tasks: [] }),
    }),
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "builtin-apps-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("builtin-apps.ts — boot-time mount, no app_install required", () => {
  it("registers all builtin tool ids with their ui.resourceUri on a fresh server", async () => {
    const client = await setup()
    const { tools } = await client.listTools()

    for (const { toolId, resourceUri } of EXPECTED) {
      const tool = tools.find(t => t.name === toolId)
      expect(tool, `expected tool "${toolId}" to be registered`).toBeDefined()
      // @ts-expect-error — _meta is non-standard but present in protocol
      expect(tool?._meta?.ui?.resourceUri).toBe(resourceUri)
    }

    await client.close()
  })

  it("serves each panel's ui:// resource", async () => {
    const client = await setup()
    const { resources } = await client.listResources()

    for (const { resourceUri } of EXPECTED) {
      const resource = resources.find(r => r.uri === resourceUri)
      expect(resource, `expected resource "${resourceUri}" to be listed`).toBeDefined()
      expect(resource?.mimeType).toBe("text/html;profile=mcp-app")
    }

    await client.close()
  })

  it("serves the session-chat widget as a self-bootstrapping bridge page (agent_start's launch card)", async () => {
    // agent_start binds to ui://agentproto_session_chat/view (agent-tools.ts);
    // the resource is rendered once with empty initData, so the page must
    // resolve the deep link at runtime from the host's tool-result push.
    const client = await setup()
    const result = await client.readResource({ uri: "ui://agentproto_session_chat/view" })
    const content = result.contents[0]
    if (!content || !("text" in content)) throw new Error("expected text resource")

    expect(content.mimeType).toBe("text/html;profile=mcp-app")
    expect(content.text).toContain("appInfo")
    expect(content.text).toContain("ui/notifications/tool-result")
    expect(content.text).toContain("extractToolResultSessionId")
    expect(content.text).toContain("callTool('agentproto_session_chat'")
    expect(content.text).not.toContain("<iframe")

    await client.close()
  })
})
