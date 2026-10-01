/**
 * registerMcpApps — OpenAI extension serialization (plan W-B, §2 + §3.2),
 * driven by DIRECT AgnoMcpApp fixtures over a REAL McpServer + Client pair
 * (no installed-app mapper — that is W-C). Acceptance: tools/list,
 * resources/list and resources/read match §2 exactly; one tool + one
 * ui:// resource exist regardless of entrypoint count; no extension means
 * no `openai/*` metadata anywhere on the wire.
 *
 * Probed SDK fact (1.30.1): McpServer.registerTool keeps a config `title`
 * on the wire but DROPS the standard top-level `icons` field from the
 * tools/list payload — so the declared icon set is serialized inside
 * `_meta["openai/ui"]` (the namespaced record that survives to
 * OpenAI-class hosts) rather than at toolDefinition level.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import type { AgnoMcpApp, OpenAIIcon, OpenAIEntrypoint } from "@agentproto/apps"

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const ICONS: OpenAIIcon[] = [
  { src: "data:image/svg+xml;base64,PHN2Zy8+", mimeType: "image/svg+xml" },
  { src: "https://cdn.example.com/dossier.png", sizes: ["256x256"], theme: "dark" },
]

function openaiApp(
  openai: AgnoMcpApp["openai"],
  overrides: Partial<AgnoMcpApp> = {},
): AgnoMcpApp<Record<string, unknown>, Record<string, unknown>> {
  const app: AgnoMcpApp<Record<string, unknown>, Record<string, unknown>> = {
    id: "app_ui_dossier",
    title: "Dossier desk",
    description: "Dossier desk panel",
    inputSchema: z.object({ view: z.string().optional() }),
    execute: async args => ({ appId: "x", tools: [] as string[], view: args?.view }),
    html: () => "<html>dossier</html>",
    ...(openai ? { openai } : {}),
    ...overrides,
  } as AgnoMcpApp<Record<string, unknown>, Record<string, unknown>>
  return app
}

/** Table of declared entrypoint sets → every row must serialize onto the
 *  SAME single generated UI tool without adding a second tool/resource. */
const ENTRYPOINT_TABLE: { name: string; entrypoints: OpenAIEntrypoint[] }[] = [
  { name: "global only", entrypoints: [{ type: "global" }] },
  { name: "thread only", entrypoints: [{ type: "thread" }] },
  { name: "global+thread", entrypoints: [{ type: "global" }, { type: "thread" }] },
  {
    name: "global+thread+file",
    entrypoints: [{ type: "global" }, { type: "thread" }, { type: "file", extensions: [".md", ".pdf"] }],
  },
]

describe("registerMcpApps — openai extension metadata", () => {
  it("openai-entrypoint-reuses-existing-ui-resource — tool _meta.ui.resourceUri stays the SAME ui:// uri the single resource is served at", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [openaiApp({ tool: { entrypoints: ENTRYPOINT_TABLE[2]!.entrypoints } })])
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    const tool = tools[0]!
    expect(tool.name).toBe("app_ui_dossier")
    expect((tool._meta?.ui as { resourceUri?: string }).resourceUri).toBe("ui://app_ui_dossier/view")
    expect(tool._meta?.["openai/ui"]).toBeDefined()

    const { resources } = await client.listResources()
    expect(resources).toHaveLength(1)
    expect(resources[0]!.uri).toBe("ui://app_ui_dossier/view")
    expect(resources[0]!.mimeType).toBe("text/html;profile=mcp-app")

    const read = await client.readResource({ uri: "ui://app_ui_dossier/view" })
    expect(read.contents[0]!.uri).toBe("ui://app_ui_dossier/view")
    // The tool's resource pointer and the served resource are one and the
    // same surface — the entrypoints decorate it, never duplicate it (I2).
    expect((tool._meta?.ui as { resourceUri?: string }).resourceUri).toBe(read.contents[0]!.uri)
    await client.close()
  })

  it("global-entrypoint-advertised-and-accepts-empty-input — {type:\"global\"} is serialized and the tool accepts {}", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [openaiApp({ tool: { entrypoints: [{ type: "global" }] } })])
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools[0]!._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }] })
    // Global entrypoints are opened with {} — the schema must accept it.
    const result = await client.callTool({ name: "app_ui_dossier", arguments: {} })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(JSON.parse((result as { content: { text: string }[] }).content[0]!.text)).toEqual({
      appId: "x",
      tools: [],
      view: undefined,
    })
    await client.close()
  })

  it("thread-entrypoint-advertised-on-same-tool — a thread entrypoint lives on the one generated tool and its ui:// resource", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [openaiApp({ tool: { entrypoints: [{ type: "thread" }] } })])
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]!._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "thread" }] })

    const { resources } = await client.listResources()
    expect(resources).toHaveLength(1)
    expect(resources[0]!.uri).toBe("ui://app_ui_dossier/view")
    await client.close()
  })

  it("every entrypoint-table row serializes onto the same single tool", async () => {
    for (const row of ENTRYPOINT_TABLE) {
      const server = new McpServer({ name: "t", version: "0.0.0" })
      registerMcpApps(server, [openaiApp({ tool: { entrypoints: row.entrypoints } })])
      const client = await connect(server)
      const { tools } = await client.listTools()
      expect(tools, row.name).toHaveLength(1)
      expect(tools[0]!._meta?.["openai/ui"], row.name).toEqual({ entrypoints: row.entrypoints })
      const { resources } = await client.listResources()
      expect(resources, row.name).toHaveLength(1)
      await client.close()
    }
  })

  it("entrypoint-tool-projects-title-and-icons — declared icons ride _meta[\"openai/ui\"] and the app title becomes the tool title", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [openaiApp({ tool: {}, icons: ICONS })])
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools[0]!.title).toBe("Dossier desk")
    expect(tools[0]!._meta?.["openai/ui"]).toEqual({ icons: ICONS })
    await client.close()
  })

  it("openai-display-hints-live-on-resource — display modes readable on resources/list AND resources/read _meta[\"openai/ui\"]", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [
      openaiApp({ resource: { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" } }),
    ])
    const client = await connect(server)

    const { resources } = await client.listResources()
    expect(resources[0]!._meta?.["openai/ui"]).toEqual({
      availableDisplayModes: ["inline", "fullscreen"],
      preferredDisplayMode: "fullscreen",
    })
    // Canonical _meta.ui untouched (csp-less app → prefersBorder only).
    expect(resources[0]!._meta?.ui).toEqual({ prefersBorder: true })

    const read = await client.readResource({ uri: "ui://app_ui_dossier/view" })
    expect(read.contents[0]!._meta?.["openai/ui"]).toEqual({
      availableDisplayModes: ["inline", "fullscreen"],
      preferredDisplayMode: "fullscreen",
    })
    await client.close()
  })

  it("no `openai` block ⇒ the wire snapshot is byte-identical to the portable baseline (I1/I5)", async () => {
    const plain = new McpServer({ name: "t", version: "0.0.0" })
    const twin = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(plain, [openaiApp(undefined)])
    registerMcpApps(twin, [openaiApp(undefined)])

    const [plainClient, twinClient] = await Promise.all([connect(plain), connect(twin)])
    const plainTools = await plainClient.listTools()
    const twinTools = await twinClient.listTools()
    expect(JSON.stringify(twinTools)).toBe(JSON.stringify(plainTools))

    const plainResources = await plainClient.listResources()
    const twinResources = await twinClient.listResources()
    expect(JSON.stringify(twinResources.resources)).toBe(JSON.stringify(plainResources.resources))
    const plainRead = await plainClient.readResource({ uri: "ui://app_ui_dossier/view" })
    const twinRead = await twinClient.readResource({ uri: "ui://app_ui_dossier/view" })
    expect(JSON.stringify(twinRead)).toBe(JSON.stringify(plainRead))

    // And explicitly: no openai/* key anywhere on tool, list, or read.
    expect(JSON.stringify([plainTools, plainResources, plainRead])).not.toContain("openai/")
    await Promise.all([plainClient.close(), twinClient.close()])
  })

  it("portable-host-ignores-openai-metadata — the portable surface stays intact beside the vendor keys and the tool stays callable", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerMcpApps(server, [
      openaiApp({
        tool: { entrypoints: [{ type: "global" }, { type: "thread" }] },
        resource: { availableDisplayModes: ["inline"] },
        icons: ICONS,
      }),
    ])
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    // The portable MCP Apps surface is intact beside the vendor keys:
    expect((tools[0]!._meta?.ui as { resourceUri?: string }).resourceUri).toBe("ui://app_ui_dossier/view")
    expect((tools[0]!._meta?.ui as { visibility?: string[] }).visibility).toEqual(["model", "app"])
    expect(tools[0]!.inputSchema).toMatchObject({
      type: "object",
      properties: { view: { type: "string" } },
    })

    const { resources } = await client.listResources()
    expect(resources[0]!.mimeType).toBe("text/html;profile=mcp-app")
    const read = await client.readResource({ uri: "ui://app_ui_dossier/view" })
    expect(read.contents[0]!.mimeType).toBe("text/html;profile=mcp-app")
    expect((read.contents[0] as { text?: string }).text).toBe("<html>dossier</html>")

    // The tool itself is still normally callable — unknown vendor metadata
    // never changes base tool/resource behavior.
    const call = await client.callTool({ name: "app_ui_dossier", arguments: { view: "wallets" } })
    expect(JSON.parse((call as { content: { text: string }[] }).content[0]!.text).view).toBe("wallets")
    await client.close()
  })
})
