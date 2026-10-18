/**
 * Unit tests for `tool_help` and the `getToolHelp`/`listToolHelpTopics`
 * readers it wraps — the fetch side of the slimmed-description contract
 * (see tool-help.ts, tool-help-mcp.ts).
 */

import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { createGateway } from "../index.js"
import { registerToolHelpTool } from "../tool-help-mcp.js"
import { getToolHelp, listToolHelpTopics } from "../tool-help.js"

async function buildHarness(): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerToolHelpTool(server)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, close: () => client.close() }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return content?.[0]?.text ?? ""
}

describe("getToolHelp / listToolHelpTopics", () => {
  it("returns the agent_start doc shipped with the package", () => {
    const doc = getToolHelp("agent_start")
    expect(doc).toBeDefined()
    expect(doc).toContain("agent_start")
  })

  it("returns undefined for a tool with no doc", () => {
    expect(getToolHelp("definitely_not_a_real_tool_xyz")).toBeUndefined()
  })

  it("lists agent_start among the available topics", () => {
    expect(listToolHelpTopics()).toContain("agent_start")
  })
})

describe("tool_help MCP tool", () => {
  it("lists as tool_help", async () => {
    const { client, close } = await buildHarness()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain("tool_help")
    await close()
  })

  it("returns the full doc for a known tool", async () => {
    const { client, close } = await buildHarness()
    const result = await client.callTool({ name: "tool_help", arguments: { name: "agent_start" } })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("agent_start")
    await close()
  })

  it("errors with a topic list for an unknown tool", async () => {
    const { client, close } = await buildHarness()
    const result = await client.callTool({
      name: "tool_help",
      arguments: { name: "not_a_real_tool" },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("not_a_real_tool")
    await close()
  })

  it("returns just the named section when topic is given", async () => {
    const { client, close } = await buildHarness()
    const result = await client.callTool({
      name: "tool_help",
      arguments: { name: "agent_start", topic: "worktree" },
    })
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain("## worktree")
    expect(text).not.toContain("## sandbox")
    await close()
  })

  it("falls back to the full doc when the topic doesn't exist", async () => {
    const { client, close } = await buildHarness()
    const result = await client.callTool({
      name: "tool_help",
      arguments: { name: "agent_start", topic: "not-a-real-section" },
    })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("not-a-real-section")
    await close()
  })
})

/** Every `tool_help {name, topic}` pointer in a tool's advertised text, so a
 *  slimming pass that trims a description down to a pointer can't leave the
 *  caller with a dangling one (the pointer still has to resolve to a real
 *  `## <topic>` section in the shipped doc). */
const POINTER_RE = /tool_help \{name:"([^"]+)"(?:, topic:"([^"]+)")?\}/g

function collectStrings(obj: unknown, out: string[]): void {
  if (typeof obj === "string") {
    out.push(obj)
    return
  }
  if (!obj || typeof obj !== "object") return
  for (const value of Object.values(obj as Record<string, unknown>)) collectStrings(value, out)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

describe("tool_help pointers resolve", () => {
  it("every advertised tool_help {name, topic} points at a real doc section", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-tool-help-ws-"))
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
    })
    const texts: string[] = []
    try {
      const client = new Client({ name: "tool-help-pointer-test", version: "0" })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
      const { tools } = await client.listTools()
      await client.close()
      for (const tool of tools) collectStrings(tool, texts)
    } finally {
      await gateway.stop().catch(() => {})
      await rm(workspace, { recursive: true, force: true })
    }

    const dangling: string[] = []
    for (const text of texts) {
      for (const match of text.matchAll(POINTER_RE)) {
        const [, name, topic] = match
        const doc = getToolHelp(name!)
        if (doc === undefined) {
          dangling.push(`tool_help {name:"${name}"} — no doc for that tool`)
          continue
        }
        if (topic !== undefined && !topic.includes("<") && !doc.includes(`## ${topic}`)) {
          dangling.push(`tool_help {name:"${name}", topic:"${topic}"} — no "## ${topic}" section`)
        }
      }
    }
    expect(dangling, dangling.join("\n")).toEqual([])
  })
})
