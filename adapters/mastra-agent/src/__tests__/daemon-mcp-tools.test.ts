/**
 * P7 deliverable 1 — the generic daemon MCP tool proxy. Exercises
 * `listDaemonMcpTools` / `makeDaemonMcpProxyTool` against a REAL
 * `McpServer` connected over `InMemoryTransport` (same fake-server pattern
 * `packages/runtime/src/__tests__/app-tools.test.ts` uses for its own MCP
 * transport coverage) — no real daemon, no real network, so these never
 * risk reaching this machine's actual `~/.agentproto/runtime.json` daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { injectAppId, listDaemonMcpTools, makeDaemonMcpProxyTool, relaxAppIdRequirement } from "../daemon-mcp-tools.js"

describe("injectAppId", () => {
  it("injects appId into an app_* call that omits one", () => {
    expect(injectAppId("app_data_read", { path: "sites.json" }, "@test/seo-crew")).toEqual({
      path: "sites.json",
      appId: "@test/seo-crew",
    })
  })

  it("never overrides an appId the model already supplied", () => {
    expect(injectAppId("app_data_read", { path: "x", appId: "other-app" }, "@test/seo-crew")).toEqual({
      path: "x",
      appId: "other-app",
    })
  })

  it("leaves a non-app_ tool's args untouched", () => {
    expect(injectAppId("mcp_imported_call", { alias: "openseo" }, "@test/seo-crew")).toEqual({
      alias: "openseo",
    })
  })

  it("is a no-op when no appId is known", () => {
    expect(injectAppId("app_data_read", { path: "x" }, undefined)).toEqual({ path: "x" })
  })
})

describe("relaxAppIdRequirement", () => {
  const schema = { type: "object", properties: { appId: {}, path: {} }, required: ["appId", "path"] }

  it("drops appId from `required` when an appId is known for an app_ tool", () => {
    expect(relaxAppIdRequirement(schema, "app_data_read", "@test/seo-crew")).toEqual({
      ...schema,
      required: ["path"],
    })
  })

  it("leaves the schema untouched when no appId is known", () => {
    expect(relaxAppIdRequirement(schema, "app_data_read", undefined)).toBe(schema)
  })

  it("leaves the schema untouched for a non-app_ tool", () => {
    expect(relaxAppIdRequirement(schema, "mcp_imported_call", "@test/seo-crew")).toBe(schema)
  })

  it("is a no-op when the schema doesn't require appId in the first place", () => {
    const noAppIdRequired = { type: "object", properties: { path: {} }, required: ["path"] }
    expect(relaxAppIdRequirement(noAppIdRequired, "app_data_read", "@test/seo-crew")).toBe(noAppIdRequired)
  })
})

async function buildFakeDaemon() {
  const server = new McpServer({ name: "fake-daemon", version: "0.0.0" })
  server.tool(
    "app_data_read",
    "Read an app data file.",
    { appId: z.string(), path: z.string() },
    async input => ({
      content: [{ type: "text" as const, text: "ignored — structuredContent wins" }],
      structuredContent: { appId: input.appId, path: input.path, exists: true, content: { sites: 2 } },
    }),
  )
  server.tool("text_only_tool", "Returns plain text, no structuredContent.", { msg: z.string() }, async input => ({
    content: [{ type: "text" as const, text: `echo: ${input.msg}` }],
  }))
  server.tool("failing_tool", "Always fails.", {}, async () => ({
    content: [{ type: "text" as const, text: "boom: bad input" }],
    isError: true,
  }))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
  await client.connect(clientTransport)
  return { client, server }
}

describe("listDaemonMcpTools", () => {
  let client: Client
  beforeEach(async () => {
    ;({ client } = await buildFakeDaemon())
  })
  afterEach(async () => {
    await client.close()
  })

  it("projects the fake daemon's tools/list into name/description/inputSchema", async () => {
    const defs = await listDaemonMcpTools(client)
    const names = defs.map(d => d.name).sort()
    expect(names).toEqual(["app_data_read", "failing_tool", "text_only_tool"])
    const appDataRead = defs.find(d => d.name === "app_data_read")!
    expect(appDataRead.description).toBe("Read an app data file.")
    expect(appDataRead.inputSchema).toMatchObject({
      type: "object",
      properties: { appId: expect.any(Object), path: expect.any(Object) },
    })
  })
})

describe("makeDaemonMcpProxyTool", () => {
  let client: Client
  beforeEach(async () => {
    ;({ client } = await buildFakeDaemon())
  })
  afterEach(async () => {
    await client.close()
  })

  it("calls tools/call and returns structuredContent when present", async () => {
    const defs = await listDaemonMcpTools(client)
    const def = defs.find(d => d.name === "app_data_read")!
    const tool = makeDaemonMcpProxyTool(def, { getClient: async () => client, appId: "@test/seo-crew" })
    const result = await (tool.execute as (input: unknown) => Promise<unknown>)({ path: "sites.json" })
    // appId was injected (the call omitted it) — proven by it round-tripping
    // back in the fake server's structuredContent.
    expect(result).toEqual({ appId: "@test/seo-crew", path: "sites.json", exists: true, content: { sites: 2 } })
  })

  it("falls back to extracted text when there's no structuredContent", async () => {
    const defs = await listDaemonMcpTools(client)
    const def = defs.find(d => d.name === "text_only_tool")!
    const tool = makeDaemonMcpProxyTool(def, { getClient: async () => client })
    const result = await (tool.execute as (input: unknown) => Promise<unknown>)({ msg: "hi" })
    expect(result).toBe("echo: hi")
  })

  it("throws with the daemon's error text when the call is isError", async () => {
    const defs = await listDaemonMcpTools(client)
    const def = defs.find(d => d.name === "failing_tool")!
    const tool = makeDaemonMcpProxyTool(def, { getClient: async () => client })
    await expect((tool.execute as (input: unknown) => Promise<unknown>)({})).rejects.toThrow(
      /daemon tool "failing_tool" failed: boom: bad input/,
    )
  })

  it("never injects appId for a non-app_ tool", async () => {
    const defs = await listDaemonMcpTools(client)
    const def = defs.find(d => d.name === "text_only_tool")!
    let seenArgs: unknown
    const spyClient = {
      callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
        seenArgs = params.arguments
        return { content: [{ type: "text" as const, text: "ok" }] }
      },
    } as unknown as Client
    const tool = makeDaemonMcpProxyTool(def, { getClient: async () => spyClient, appId: "@test/seo-crew" })
    await (tool.execute as (input: unknown) => Promise<unknown>)({ msg: "hi" })
    expect(seenArgs).toEqual({ msg: "hi" })
  })
})
