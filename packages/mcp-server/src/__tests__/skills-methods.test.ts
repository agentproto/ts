/**
 * Native MCP Skills transport (beta extension `io.modelcontextprotocol/skills`):
 * the two methods dispatch as native JSON-RPC methods, the extension and the
 * `resources` capability are announced only when the methods are registered,
 * and a handler error keeps its JSON-RPC code on the wire.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { MCP_SKILLS_EXTENSION, registerSkillsMethods, type SkillsMethodsHandlers } from "../skills-methods.js"

const handlers = (overrides: Partial<SkillsMethodsHandlers> = {}): SkillsMethodsHandlers => ({
  list: async () => ({ skills: [{ uri: "skill://a/SKILL.md" }] }),
  get: async (params) => ({ skill: { uri: params.uri } }),
  read: async (uri) => ({ uri: uri.href, mimeType: "text/markdown", text: "# a" }),
  ...overrides,
})

async function rawInitialize(server: McpServer): Promise<Record<string, any>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const reply = new Promise<Record<string, any>>(resolve => {
    clientTransport.onmessage = message => resolve(message as never)
  })
  await clientTransport.start()
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  })
  const out = await reply
  await server.close()
  return out.result.capabilities
}

describe("mcp skills native methods", () => {
  it("announces the extension and resources only when registered", async () => {
    const on = new McpServer({ name: "s", version: "0" })
    registerSkillsMethods(on, handlers())
    const caps = await rawInitialize(on)
    expect(caps.extensions).toEqual({ [MCP_SKILLS_EXTENSION]: {} })
    expect(caps.resources).toBeDefined()
    const off = await rawInitialize(new McpServer({ name: "s", version: "0" }))
    expect(off.extensions).toBeUndefined()
    expect(off.resources).toBeUndefined()
  })

  it("dispatches skills/list, skills/get and resources/read natively", async () => {
    const server = new McpServer({ name: "s", version: "0" })
    registerSkillsMethods(server, handlers())
    const [c, s] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "t", version: "0" })
    await Promise.all([server.connect(s), client.connect(c)])
    const call = (method: string, params: Record<string, unknown>) =>
      client.request({ method, params } as never, z.looseObject({}))
    expect(await call("skills/list", {})).toEqual({ skills: [{ uri: "skill://a/SKILL.md" }] })
    expect(await call("skills/get", { uri: "skill://a/SKILL.md" })).toEqual({ skill: { uri: "skill://a/SKILL.md" } })
    const read = (await client.readResource({ uri: "skill://a/docs/x.md" })) as { contents: Array<Record<string, unknown>> }
    expect(read.contents).toEqual([{ uri: "skill://a/docs/x.md", mimeType: "text/markdown", text: "# a" }])
    await client.close()
  })

  it("keeps the JSON-RPC code of a handler error", async () => {
    const server = new McpServer({ name: "s", version: "0" })
    registerSkillsMethods(
      server,
      handlers({
        get: async () => {
          throw new McpError(ErrorCode.InvalidParams, "unknown skill")
        },
        read: async () => {
          throw new McpError(ErrorCode.InvalidParams, "file is not listed")
        },
      }),
    )
    const [c, s] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "t", version: "0" })
    await Promise.all([server.connect(s), client.connect(c)])
    await expect(client.request({ method: "skills/get", params: { uri: "x" } } as never, z.looseObject({}))).rejects.toMatchObject({ code: -32602 })
    await expect(client.readResource({ uri: "skill://a/zzz" })).rejects.toMatchObject({ code: -32602 })
    await client.close()
  })
})
