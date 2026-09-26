/**
 * registerUiResource: a `ui://` HTML panel served over a real McpServer +
 * Client pair, with `_meta.ui` visible on both resources/list and
 * resources/read (hosts read csp from the read result first).
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MCP_APP_MIME_TYPE, registerUiResource } from "../register-ui-resource.js"

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

describe("registerUiResource", () => {
  it("serves the HTML with the mcp-app mime and _meta.ui on list and read", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    const csp = { connectDomains: ["https://api.example.com"] }
    registerUiResource(server, {
      name: "demo",
      uri: "ui://demo/view",
      html: "<p>hi</p>",
      description: "Demo panel",
      csp,
    })
    const client = await connect(server)

    const { resources } = await client.listResources()
    const listed = resources.find((r) => r.uri === "ui://demo/view")
    expect(listed?.mimeType).toBe(MCP_APP_MIME_TYPE)
    expect(listed?.description).toBe("Demo panel")
    expect(listed?._meta).toEqual({ ui: { prefersBorder: true, csp } })

    const { contents } = await client.readResource({ uri: "ui://demo/view" })
    expect(contents).toHaveLength(1)
    expect(contents[0]).toEqual({
      uri: "ui://demo/view",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>hi</p>",
      _meta: { ui: { prefersBorder: true, csp } },
    })
    await client.close()
  })

  it("re-runs an html producer on every read and honours prefersBorder", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    let n = 0
    registerUiResource(server, {
      name: "counter",
      uri: "ui://counter/view",
      html: async () => `<p>${++n}</p>`,
      prefersBorder: false,
    })
    const client = await connect(server)

    const first = await client.readResource({ uri: "ui://counter/view" })
    const second = await client.readResource({ uri: "ui://counter/view" })
    expect(first.contents[0]).toMatchObject({
      text: "<p>1</p>",
      _meta: { ui: { prefersBorder: false } },
    })
    expect(second.contents[0]).toMatchObject({ text: "<p>2</p>" })
    expect(first.contents[0]?._meta).toEqual({ ui: { prefersBorder: false } })
    await client.close()
  })
})
