/**
 * An `imported:` entry of `exposes.tools` behaves like the original tool on
 * the /mcp gateway: its result passes through intact, its `_meta.ui` widget
 * link is copied onto `tools/list`, the app's `exposes.resources` allowlist is
 * relayed on `resources/read` (and nothing else), and keys its `inputSchema`
 * does not declare never reach the import.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { createAppRegistry, type AppRegistry, type InstalledApp } from "../app-registry.js"
import { registerExposedAppTools, type RegisterExposedAppToolsOptions } from "../app-exposed-tools.js"
import { performExposedToolCall } from "../app-tools.js"
import { exposedToolGrantKey } from "../exposed-tools-policy.js"

const SCREENSHOT_URI = "ui://bureau/screenshot"
const RECORDING_URI = "ui://bureau/recording"

const IMPORTED_RESULT = {
  content: [
    { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    { type: "text", text: "captured" },
  ],
  structuredContent: { width: 1280, height: 800 },
  _meta: { "bureau/capture": { id: "cap-1" } },
}

let dir = ""
let registry: AppRegistry

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exposed-imported-"))
  registry = createAppRegistry()
  registry.upsertApp({
    appId: "@t/bureau",
    dir,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    exposes: {
      agents: [],
      workflows: [],
      prefix: "bureau",
      tools: [
        {
          id: "imported:bureau/browser_screenshot",
          access: "read",
          description: "Capture the page.",
          mcpName: "bureau_screenshot",
          inputSchema: { type: "object", properties: { instance: { type: "string" } } },
        },
      ],
      resources: [SCREENSHOT_URI],
    },
  } as unknown as InstalledApp)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeImport() {
  const callImportedTool = vi.fn(
    async (_alias: string, _tool: string, _args: Record<string, unknown>, _callerSessionId?: string) =>
      structuredClone(IMPORTED_RESULT),
  )
  const listImportedTools = vi.fn(async (alias: string) =>
    alias === "bureau"
      ? [
          { name: "browser_screenshot", _meta: { ui: { resourceUri: SCREENSHOT_URI } } },
          { name: "browser_record_stop", _meta: { ui: { resourceUri: RECORDING_URI } } },
        ]
      : undefined,
  )
  // The import serves BOTH views; only the allowlisted one may get through.
  const readImportedResource = vi.fn(
    async (_alias: string, uri: string): Promise<ReadResourceResult> => ({
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: `<html>${uri}</html>` }],
    }),
  )
  return { callImportedTool, listImportedTools, readImportedResource }
}

async function connect(opts: Partial<RegisterExposedAppToolsOptions>): Promise<Client> {
  const server = new McpServer({ name: "gateway", version: "0" })
  await registerExposedAppTools(server, { appRegistry: registry, mode: "read", ...opts })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} })
  await client.connect(clientSide)
  return client
}

describe("an imported exposed tool on the /mcp gateway", () => {
  it("returns the import's CallToolResult unchanged: image block, structuredContent and _meta", async () => {
    const client = await connect(fakeImport())
    const result = await client.callTool({ name: "bureau_screenshot", arguments: { instance: "main" } })
    expect(result).toEqual(IMPORTED_RESULT)
  })

  it("keeps the result intact through performExposedToolCall too", async () => {
    const result = await performExposedToolCall(
      registry,
      { appId: "@t/bureau", id: "imported:bureau/browser_screenshot", args: {} },
      fakeImport(),
    )
    expect(result).toEqual(IMPORTED_RESULT)
  })

  it("copies the imported tool's _meta.ui onto tools/list, resourceUri unchanged", async () => {
    const fake = fakeImport()
    const client = await connect(fake)
    const tool = (await client.listTools()).tools.find(t => t.name === "bureau_screenshot")
    expect(tool?._meta).toEqual({ ui: { resourceUri: SCREENSHOT_URI } })
    expect(fake.listImportedTools).toHaveBeenCalledWith("bureau")
  })

  it("relays resources/read for an allowlisted URI and refuses one the import also serves", async () => {
    const fake = fakeImport()
    const client = await connect(fake)

    const read = await client.readResource({ uri: SCREENSHOT_URI })
    expect(read.contents).toEqual([
      { uri: SCREENSHOT_URI, mimeType: "text/html;profile=mcp-app", text: `<html>${SCREENSHOT_URI}</html>` },
    ])
    expect(fake.readImportedResource).toHaveBeenCalledWith("bureau", SCREENSHOT_URI)

    await expect(client.readResource({ uri: RECORDING_URI })).rejects.toThrow(/not found/i)
    expect(fake.readImportedResource).not.toHaveBeenCalledWith("bureau", RECORDING_URI)

    expect((await client.listResources()).resources.map(r => r.uri)).toEqual([SCREENSHOT_URI])
  })

  it("drops an input key the entry's inputSchema does not declare before the imported call", async () => {
    const fake = fakeImport()
    await performExposedToolCall(
      registry,
      {
        appId: "@t/bureau",
        id: "imported:bureau/browser_screenshot",
        args: { instance: "main", path: "/tmp/out.png" },
      },
      fake,
    )
    // No caller session given: none reaches the import.
    expect(fake.callImportedTool).toHaveBeenCalledWith("bureau", "browser_screenshot", { instance: "main" }, undefined)

    const client = await connect(fake)
    await client.callTool({ name: "bureau_screenshot", arguments: { instance: "b", path: "/tmp/out.png" } })
    expect(fake.callImportedTool).toHaveBeenLastCalledWith("bureau", "browser_screenshot", { instance: "b" }, undefined)
  })

  it("relays nothing when defaults.apps.exposedTools is off", async () => {
    const fake = fakeImport()
    const client = await connect({ ...fake, mode: "off" })
    await expect(client.readResource({ uri: SCREENSHOT_URI })).rejects.toThrow()
    expect(fake.readImportedResource).not.toHaveBeenCalled()
    expect(fake.listImportedTools).not.toHaveBeenCalled()
  })
})

describe("an imported exposed tool at access: write", () => {
  beforeEach(() => {
    const app = registry.getApp("@t/bureau")!
    registry.upsertApp({
      ...app,
      exposes: {
        ...app.exposes!,
        tools: [
          ...(app.exposes!.tools ?? []),
          {
            id: "imported:bureau/browser_navigate",
            access: "write",
            description: "Open a URL in a browser tab the caller owns.",
            mcpName: "navigate",
            inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "string" } } },
          },
        ],
      },
    } as unknown as InstalledApp)
  })

  // A server with no tool at all answers tools/list with "method not found": nothing listed.
  const names = async (opts: Partial<RegisterExposedAppToolsOptions>) =>
    (await connect({ ...fakeImport(), ...opts }))
      .listTools()
      .then(r => r.tools.map(t => t.name), () => [] as string[])

  it("is hidden in mode read, visible in mode all, to an opted-in caller and to a caller its app grants", async () => {
    expect(await names({})).not.toContain("bureau_navigate")
    expect(await names({ caller: { sessionId: "s1", optIn: ["bureau_screenshot"] } })).not.toContain("bureau_navigate")
    expect(await names({ mode: "all" })).toContain("bureau_navigate")
    expect(await names({ caller: { sessionId: "s1", optIn: ["bureau_navigate"] } })).toContain("bureau_navigate")
    expect(
      await names({ caller: { sessionId: "s1", grants: new Set([exposedToolGrantKey("@t/bureau", "bureau_navigate")]) } }),
    ).toContain("bureau_navigate")
    // A grant names the provider app too: the same name under another app grants nothing.
    expect(
      await names({ caller: { sessionId: "s1", grants: new Set([exposedToolGrantKey("@t/other", "bureau_navigate")]) } }),
    ).not.toContain("bureau_navigate")
    expect(await names({ mode: "off", caller: { sessionId: "s1", optIn: ["bureau_navigate"] } })).not.toContain(
      "bureau_navigate",
    )
  })

  it("forwards only the declared inputSchema args, plus the caller session, to the import", async () => {
    const fake = fakeImport()
    const client = await connect({ ...fake, caller: { sessionId: "sess-42", optIn: ["bureau_navigate"] } })
    const tool = (await client.listTools()).tools.find(t => t.name === "bureau_navigate")
    expect(tool?.annotations).toEqual({ destructiveHint: true })
    await client.callTool({ name: "bureau_navigate", arguments: { url: "https://example.com", tabId: "t1", path: "/x" } })
    expect(fake.callImportedTool).toHaveBeenLastCalledWith(
      "bureau",
      "browser_navigate",
      { url: "https://example.com", tabId: "t1" },
      "sess-42",
    )
  })
})
