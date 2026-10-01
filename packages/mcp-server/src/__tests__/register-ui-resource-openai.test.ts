/**
 * registerUiResource — OpenAI extension metadata (plan W-B, §3.2): an
 * optional `meta` record is serialized as a SIBLING of the canonical
 * `_meta.ui` on BOTH resources/list and resources/read, and a
 * caller-supplied `ui` key is refused so the canonical
 * prefersBorder/csp metadata can never be overwritten (risk table:
 * "OpenAI metadata overwrites MCP Apps CSP metadata").
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MCP_APP_MIME_TYPE, registerUiResource } from "../register-ui-resource.js"

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe("registerUiResource meta (openai display hints)", () => {
  const DISPLAY_HINTS = {
    availableDisplayModes: ["inline", "fullscreen"],
    preferredDisplayMode: "fullscreen",
  }

  it("copies namespaced meta to BOTH resources/list and resources/read, alongside canonical _meta.ui", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerUiResource(server, {
      name: "demo",
      uri: "ui://demo/view",
      html: "<p>hi</p>",
      csp: { connectDomains: ["https://api.example.com"] },
      meta: { "openai/ui": { ...DISPLAY_HINTS } },
    })
    const client = await connect(server)

    const { resources } = await client.listResources()
    const listed = resources.find(r => r.uri === "ui://demo/view")
    expect(listed?._meta).toEqual({
      ui: { prefersBorder: true, csp: { connectDomains: ["https://api.example.com"] } },
      "openai/ui": { ...DISPLAY_HINTS },
    })

    const { contents } = await client.readResource({ uri: "ui://demo/view" })
    expect(contents[0]).toMatchObject({
      uri: "ui://demo/view",
      mimeType: MCP_APP_MIME_TYPE,
      text: "<p>hi</p>",
    })
    expect(contents[0]?._meta).toEqual({
      ui: { prefersBorder: true, csp: { connectDomains: ["https://api.example.com"] } },
      "openai/ui": { ...DISPLAY_HINTS },
    })
    await client.close()
  })

  it("throws when a caller smuggles a `ui` key through meta — canonical prefersBorder/csp cannot be overwritten", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    expect(() =>
      registerUiResource(server, {
        name: "demo",
        uri: "ui://demo/view",
        html: "<p>hi</p>",
        prefersBorder: false,
        meta: {
          "openai/ui": DISPLAY_HINTS,
          ui: { csp: { connectDomains: ["https://evil.example"] } },
        },
      }),
    ).toThrowError(/meta must not carry a `ui` key/)
  })

  it("baseline stays byte-identical when no meta is passed (no openai/* key appears)", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerUiResource(server, { name: "demo", uri: "ui://demo/view", html: "<p>hi</p>" })
    const client = await connect(server)
    const { resources } = await client.listResources()
    expect(resources.find(r => r.uri === "ui://demo/view")?._meta).toEqual({ ui: { prefersBorder: true } })
    const { contents } = await client.readResource({ uri: "ui://demo/view" })
    expect(contents[0]?._meta).toEqual({ ui: { prefersBorder: true } })
    expect(
      JSON.stringify([resources.map(r => r._meta), contents.map(c => c._meta)]),
    ).not.toContain("openai/")
    await client.close()
  })
})
