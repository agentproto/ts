import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  makeListTool,
  makeSetupTool,
  type SetupField,
} from "../mcp-tools.js"
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

// ── single-value form (backward compat) ──────────────────────────────

describe("makeSetupTool (single-value)", () => {
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

// ── multi-field form ─────────────────────────────────────────────────

const TUNNEL_FIELDS: readonly SetupField[] = [
  { name: "hostname", description: "Tunnel hostname", required: true, sensitive: true },
  { name: "tunnelId", description: "Tunnel UUID", required: true, sensitive: true },
  { name: "credentialsFile", description: "Optional creds file path", required: false, sensitive: true },
]

describe("makeSetupTool (multi-field)", () => {
  function build(onSetup = vi.fn(async () => ({ ok: true, hint: "configured" }))) {
    const { server, tools } = fakeServer()
    makeSetupTool({
      server,
      toolName: "setup_tunnel_provider",
      description: "Configure a tunnel provider",
      validSlugs: ["cloudflare-named"],
      fields: TUNNEL_FIELDS,
      onSetup,
    })
    return { tool: tools[0]!, onSetup }
  }

  it("schema includes slug + one zod-string param per declared field", () => {
    const { tool } = build()
    const shapeKeys = Object.keys(tool.shape).sort()
    expect(shapeKeys).toEqual(
      ["credentialsFile", "hostname", "slug", "tunnelId"].sort(),
    )
    // No 'value' key
    expect(tool.shape).not.toHaveProperty("value")
  })

  it("marks sensitive fields with SENSITIVE annotation", () => {
    const { tool } = build()
    const hostnameField = tool.shape["hostname"] as { description?: string }
    expect(hostnameField.description?.toLowerCase()).toContain("sensitive")

    const tunnelIdField = tool.shape["tunnelId"] as { description?: string }
    expect(tunnelIdField.description?.toLowerCase()).toContain("sensitive")

    const credsFileField = tool.shape["credentialsFile"] as { description?: string }
    expect(credsFileField.description?.toLowerCase()).toContain("sensitive")
  })

  it("passes field values as Record<string,string> to onSetup and NEVER echoes them", async () => {
    const { tool, onSetup } = build()
    const hostname = "secret.example.com"
    const tunnelId = "11111111-2222-3333-4444-555555555555"
    const credsFile = "/secret/path.json"

    const res = await tool.handler({ slug: "cloudflare-named", hostname, tunnelId, credentialsFile: credsFile })

    expect(onSetup).toHaveBeenCalledWith("cloudflare-named", {
      hostname,
      tunnelId,
      credentialsFile: credsFile,
    })

    const text = res.content[0]!.text
    expect(text).not.toContain(hostname)
    expect(text).not.toContain(tunnelId)
    expect(text).not.toContain(credsFile)

    const parsed = JSON.parse(text)
    expect(parsed).toEqual({ ok: true, slug: "cloudflare-named", hint: "configured" })
    expect(parsed).not.toHaveProperty("value")
    expect(parsed).not.toHaveProperty("hostname")
    expect(parsed).not.toHaveProperty("tunnelId")
    expect(parsed).not.toHaveProperty("credentialsFile")
  })

  it("rejects unknown slugs without calling onSetup", async () => {
    const onSetup = vi.fn(async () => ({ ok: true }))
    const { tool } = build(onSetup)

    const res = await tool.handler({ slug: "nope", hostname: "x", tunnelId: "y" })
    expect(res.isError).toBe(true)
    expect(onSetup).not.toHaveBeenCalled()
  })

  it("handles missing optional field (empty string default)", async () => {
    const onSetup = vi.fn(async () => ({ ok: true }))
    const { tool } = build(onSetup)

    await tool.handler({ slug: "cloudflare-named", hostname: "h", tunnelId: "t" })
    expect(onSetup).toHaveBeenCalledWith("cloudflare-named", {
      hostname: "h",
      tunnelId: "t",
      credentialsFile: "",
    })
  })
})
