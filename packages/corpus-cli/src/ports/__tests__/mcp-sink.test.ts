import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { McpSink } from "../mcp-sink.adapter.js"
import type { McpClientLike } from "../mcp-http-client.js"
import type { SinkItem } from "@agentproto/corpus"

/** Narrows a recorded MCP arg object for assertions, cast-free. */
const argsRecord = z.record(z.string(), z.unknown())

const item: SinkItem = {
  slug: "go-beyond-keywords",
  kind: "principle",
  title: "Go beyond keyword matching",
  body: "Require context for every must-have.",
  sources: ["amy-miller-jd"],
  tags: ["screening", "cv"],
  confidence: 0.95,
  access: "guild",
  uri: "corpus://go-beyond-keywords",
}

function fakeClient(): { client: McpClientLike; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const client: McpClientLike = {
    callTool: vi.fn(async (name, args) => {
      calls.push({ name, args })
      return {}
    }),
  }
  return { client, calls }
}

describe("McpSink", () => {
  it("templates entry fields into the configured tool args (typed for whole-value placeholders)", async () => {
    const { client, calls } = fakeClient()
    const sink = new McpSink(
      {
        endpoint: "http://x/mcp",
        tool: "ingest_knowledge",
        args: {
          guildId: "g1",
          kind: "text",
          title: "${title}",
          content: "${body}",
          uri: "${uri}",
          metadata: { sources: "${sources}", access: "${access}", note: "kind=${kind}" },
        },
      },
      client
    )
    const res = await sink.push(item)
    expect(res.ok).toBe(true)
    const call = calls[0]!
    expect(call.name).toBe("ingest_knowledge")
    expect(call.args.guildId).toBe("g1")
    expect(call.args.title).toBe("Go beyond keyword matching")
    expect(call.args.content).toBe("Require context for every must-have.")
    const meta = argsRecord.parse(call.args.metadata)
    expect(meta.sources).toEqual(["amy-miller-jd"]) // whole-value → typed array
    expect(meta.access).toBe("guild")
    expect(meta.note).toBe("kind=principle") // string interpolation
  })

  it("wraps via mcp_imported_call when importedAlias is set", async () => {
    const { client, calls } = fakeClient()
    const sink = new McpSink(
      { endpoint: "http://x/mcp", tool: "ingest_knowledge", importedAlias: "guilde", args: { content: "${body}" } },
      client
    )
    await sink.push(item)
    expect(calls[0]!.name).toBe("mcp_imported_call")
    expect(calls[0]!.args.alias).toBe("guilde")
    expect(calls[0]!.args.toolName).toBe("ingest_knowledge")
    expect(argsRecord.parse(calls[0]!.args.args).content).toBe(item.body)
  })

  it("reports an error result when the tool call throws", async () => {
    const client: McpClientLike = { callTool: vi.fn(async () => { throw new Error("boom") }) }
    const sink = new McpSink({ endpoint: "x", tool: "t", args: {} }, client)
    const res = await sink.push(item)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("boom")
  })
})
