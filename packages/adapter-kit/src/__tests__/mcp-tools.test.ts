import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeListTool, makeSetupTool } from "../mcp-tools.js"
import type { AdapterEntry } from "../types.js"

interface Registered {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[]
    isError?: boolean
  }>
}

function fakeServer(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = []
  const server = {
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: Registered["handler"]) => {
      tools.push({ name, description, shape, handler })
    },
  } as unknown as McpServer
  return { server, tools }
}

describe("makeListTool", () => {
  it("registers a parameterless tool that returns the entry list as JSON", async () => {
    const { server, tools } = fakeServer()
    const entries: AdapterEntry<{ slug: string }>[] = [
      { slug: "alpha", name: "Alpha", description: "a", packageName: "@x/a", status: "ready", version: "1.0.0", info: { slug: "alpha" } },
    ]
    const lister = vi.fn(async () => entries)
    makeListTool({ server, toolName: "list_adapters", description: "d", lister })

    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("list_adapters")
    expect(tools[0]!.shape).toEqual({}) // no params

    const res = await tools[0]!.handler({})
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text)).toEqual(entries)
  })
})

describe("makeSetupTool", () => {
  function build(onSetup = vi.fn(async () => ({ ok: true, hint: "configured" }))) {
    const { server, tools } = fakeServer()
    makeSetupTool({
      server,
      toolName: "setup_tunnel_provider",
      description: "Configure a tunnel provider",
      validSlugs: ["ngrok", "cloudflare-named"],
      onSetup,
    })
    return { tool: tools[0]!, onSetup }
  }

  it("marks the value param as sensitive in its schema annotation", () => {
    const { tool } = build()
    const valueField = tool.shape["value"] as { description?: string }
    expect(valueField.description?.toLowerCase()).toContain("sensitive")
  })

  it("forwards slug+value to onSetup but NEVER echoes the value back", async () => {
    const { tool, onSetup } = build()
    const secret = "tok_SUPER_SECRET_value_123"
    const res = await tool.handler({ slug: "ngrok", value: secret })

    expect(onSetup).toHaveBeenCalledWith("ngrok", secret)
    const text = res.content[0]!.text
    expect(text).not.toContain(secret)
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({ ok: true, slug: "ngrok", hint: "configured" })
    expect(parsed).not.toHaveProperty("value")
  })

  it("rejects unknown slugs without calling onSetup", async () => {
    const onSetup = vi.fn(async () => ({ ok: true }))
    const { tool } = build(onSetup)
    const res = await tool.handler({ slug: "nope", value: "x" })
    expect(res.isError).toBe(true)
    expect(onSetup).not.toHaveBeenCalled()
  })
})
