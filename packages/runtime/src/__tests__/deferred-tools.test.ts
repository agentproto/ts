/**
 * Tests for withDeferredTools over a REAL MCP transport (not just the
 * wrapper's internals) — the whole point is what a connected client
 * observes via tools/list and tools/call, which only a real McpServer +
 * Client round trip can verify.
 *
 * Design constraint under test: the daemon's HTTP MCP transport is
 * stateless-per-request (http-server.ts), so a deferred tool must stay
 * fully callable at all times — only `tools/list` visibility changes.
 * See deferred-tools.ts's module doc for why enable()/disable() was
 * rejected (confirmed broken against a live stateless gateway).
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"

import { withDeferredTools } from "../deferred-tools.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(alwaysOn: ReadonlySet<string>) {
  const rawServer = new McpServer({ name: "deferred-e2e-server", version: "0.0.0" })
  const server = withDeferredTools(rawServer, { alwaysOn })

  server.tool("agent_start", "Spawn an agent session.", { adapter: z.string() }, async () => ({
    content: [{ type: "text", text: "started" }],
  }))
  server.tool(
    "file_read",
    "Read a file from disk.",
    { path: z.string().describe("Absolute path.") },
    async () => ({ content: [{ type: "text", text: "file contents" }] }),
  )
  server.tool("directory_list", "List a directory.", { path: z.string() }, async () => ({
    content: [{ type: "text", text: "[]" }],
  }))
  // mcp-apps-adapter.ts registers its panel tools via the OTHER SDK entry
  // point (config-object overload) — must land in the deferred catalog
  // too, not just tool().
  server.registerTool(
    "agentproto_sessions",
    { description: "Sessions panel app." },
    async () => ({ content: [{ type: "text", text: "panel" }] }),
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await rawServer.connect(serverTransport)
  const client = new Client({ name: "deferred-e2e-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

describe("withDeferredTools — MCP transport e2e", () => {
  it("only always-on tools (+ tool_search) appear in the initial tools/list", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(["agent_start", "tool_search"])
  })

  it("a deferred tool is still fully callable WITHOUT ever calling tool_search first", async () => {
    // This is the core correctness property under statelessness: gating
    // tools/call on a prior search would break the very next stateless
    // request for anyone who already knows the tool's shape. "Deferred"
    // only means "hidden from tools/list", never "uncallable".
    const { client } = await setup(new Set(["agent_start"]))
    const res = (await client.callTool({
      name: "file_read",
      arguments: { path: "/tmp/x" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(res.isError).toBeFalsy()
    expect(res.content?.[0]?.text).toBe("file contents")
  })

  it("registerTool()-based tools (e.g. mcp-apps) are excluded from tools/list too, not just tool()", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).not.toContain("agentproto_sessions")

    // Still callable, same as any other deferred tool.
    const res = (await client.callTool({ name: "agentproto_sessions", arguments: {} })) as {
      isError?: boolean
    }
    expect(res.isError).toBeFalsy()
  })

  it("tool_search by keyword returns the deferred tool's full schema inline", async () => {
    const { client } = await setup(new Set(["agent_start"]))

    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "directory" } }),
    )
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe("directory_list")
    expect(result.tools[0].description).toBe("List a directory.")
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    })

    // tools/list is unaffected by having searched — no cross-request state
    // to reflect (the daemon is stateless), so it's still just alwaysOn.
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).not.toContain("directory_list")
  })

  it("select:name1,name2 matches exact names regardless of description keywords", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "select:file_read,directory_list" } }),
    )
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["directory_list", "file_read"])
  })

  it("tool_search never surfaces already-always-on tools as a match", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "select:agent_start,tool_search" } }),
    )
    expect(result.tools).toEqual([])
  })

  it("no match returns an empty list with a helpful note, not an error", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "nonexistent_xyz" } }),
    )
    expect(result.tools).toEqual([])
    expect(result.note).toBeTruthy()
  })

  it("maxResults caps the number of matches returned", async () => {
    const { client } = await setup(new Set(["agent_start"]))
    const result = parseToolJson(
      await client.callTool({ name: "tool_search", arguments: { query: "e", maxResults: 1 } }),
    )
    expect(result.tools.length).toBeLessThanOrEqual(1)
  })
})
