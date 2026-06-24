/**
 * MCP protocol tests for the export_agent_session tool.
 *
 * Uses InMemoryTransport (same approach as sessions-panel-mcp.test.ts) to
 * avoid spawning a real daemon. The export function is injected via
 * ExportSessionOps.exportFn so no real JSONL / SQLite fixtures are needed.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerExportSessionTool } from "../session-tools.js"
import type { SessionsRegistry } from "../sessions.js"
import type { ExportAgentSessionResult } from "../transcript-export.js"

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

function makeServer(
  exportFn: (input: {
    sessionId: string
    registry: SessionsRegistry
    format?: "markdown" | "json"
    adapter?: string
    cwd?: string
  }) => Promise<ExportAgentSessionResult>,
) {
  const server = new McpServer({ name: "test-export", version: "0.0.1" })
  const registry = {
    findByIdOrName: () => undefined,
  } as unknown as SessionsRegistry
  registerExportSessionTool(server, { registry, exportFn })
  return server
}

// ── tool registration ─────────────────────────────────────────────────────────

describe("export_agent_session tool — registration", () => {
  it("is listed in tools/list with a description mentioning transcript", async () => {
    const server = makeServer(async () => ({
      sessionId: "sess_test",
      adapter: "claude-code",
      format: "markdown",
      meta: {},
      content: "# test",
    }))
    const client = await makeClient(server)

    const result = await client.listTools()
    const tool = result.tools.find(t => t.name === "export_agent_session")

    expect(tool).toBeDefined()
    expect(tool?.description?.toLowerCase()).toContain("transcript")

    await client.close()
  })
})

// ── rendered content ──────────────────────────────────────────────────────────

describe("export_agent_session tool — rendered content", () => {
  const MARKDOWN_FIXTURE = `# My Session

> Session · source \`claude-code\`

| | |
|---|---|
| Model | \`claude-opus-4-8\` |

---

### 🧑 User

Hello!

### 🤖 Assistant

Hi there!
`

  it("returns the rendered markdown transcript as text content", async () => {
    const server = makeServer(async () => ({
      sessionId: "sess_001",
      adapter: "claude-code",
      format: "markdown",
      meta: { model: "claude-opus-4-8", source: "claude-code" },
      content: MARKDOWN_FIXTURE,
    }))
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "export_agent_session",
      arguments: { sessionId: "sess_001" },
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    expect(content0?.type).toBe("text")
    expect(content0?.text).toBe(MARKDOWN_FIXTURE)

    await client.close()
  })

  it("returns JSON content when format='json'", async () => {
    const jsonContent = JSON.stringify({ meta: {}, messages: [] }, null, 2)
    const server = makeServer(async input => ({
      sessionId: input.sessionId,
      adapter: "hermes",
      format: "json",
      meta: {},
      content: jsonContent,
    }))
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "export_agent_session",
      arguments: { sessionId: "sess_002", format: "json" },
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    expect(content0?.text).toBe(jsonContent)

    await client.close()
  })

  it("forwards adapter + cwd overrides to the export function", async () => {
    let capturedInput: { adapter?: string; cwd?: string } = {}
    const server = makeServer(async input => {
      capturedInput = { adapter: input.adapter, cwd: input.cwd }
      return {
        sessionId: input.sessionId,
        adapter: input.adapter ?? "claude-code",
        format: "markdown",
        meta: {},
        content: "# ok",
      }
    })
    const client = await makeClient(server)

    await client.callTool({
      name: "export_agent_session",
      arguments: {
        sessionId: "native-id-abc",
        adapter: "claude-code",
        cwd: "/home/user/project",
      },
    })

    expect(capturedInput.adapter).toBe("claude-code")
    expect(capturedInput.cwd).toBe("/home/user/project")

    await client.close()
  })
})

// ── unknown session graceful error ────────────────────────────────────────────

describe("export_agent_session tool — graceful error on unknown session", () => {
  it("returns isError=true with an Error: prefix for an unknown session", async () => {
    const server = makeServer(async () => ({
      sessionId: "sess_ghost",
      adapter: "unknown",
      format: "markdown",
      meta: {},
      content:
        'Error: session "sess_ghost" not found in registry and no adapter override supplied.',
    }))
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "export_agent_session",
      arguments: { sessionId: "sess_ghost" },
    })

    expect(result.isError).toBe(true)
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    expect(content0?.text).toContain("Error:")

    await client.close()
  })

  it("does NOT throw — returns a structured isError result, never rejects", async () => {
    const server = makeServer(async () => ({
      sessionId: "sess_bad",
      adapter: "aider",
      format: "markdown",
      meta: {},
      content: "Error: no exporter for adapter \"aider\".",
    }))
    const client = await makeClient(server)

    await expect(
      client.callTool({ name: "export_agent_session", arguments: { sessionId: "sess_bad" } }),
    ).resolves.toMatchObject({ isError: true })

    await client.close()
  })
})
