/**
 * Unit coverage for the `adapter_list` MCP tool (agent-tools.ts), focused on
 * the `summary` projection added for app-UI runner pickers (`@agentproto/
 * app-client`'s `mountRunnerSelect`) — the default (unset/false) payload
 * forwards the injected `listAgentAdapters` result verbatim, but the daemon's
 * full manifest projection can run to hundreds of KB, far heavier than a
 * picker needs. Mirrors harness-capabilities-tool.test.ts's
 * createMcpServer + InMemoryTransport pattern.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AdapterListEntry, AgentAdapterLister } from "../http-server.js"

async function harness(listAgentAdapters?: AgentAdapterLister) {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry,
    ...(listAgentAdapters ? { listAgentAdapters } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function parseAdapters(result: unknown): unknown[] {
  const content = (result as { content: Array<{ text: string }> }).content
  return (JSON.parse(content[0]!.text) as { adapters: unknown[] }).adapters
}

const FULL_ADAPTER: AdapterListEntry & { commands: unknown[]; modelDetails: unknown[] } = {
  slug: "hermes",
  name: "Hermes",
  version: "1.2.3",
  description: "A very long description that a picker never needs to render.",
  protocol: "acp",
  streaming: true,
  packageName: "@agentproto/adapter-hermes",
  modes: [],
  models: ["z-ai/glm-5.2", "gpt-5"],
  commands: [{ id: "compact", description: "Compact context" }],
  modelDetails: [{ id: "z-ai/glm-5.2", provider: "openrouter" }],
}

describe("adapter_list", () => {
  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    expect((result as { isError?: boolean }).isError).toBe(true)
    await h.close()
  })

  it("forwards the full lister payload unchanged when summary is unset", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([FULL_ADAPTER])
    await h.close()
  })

  it("projects to { slug, name, version, protocol, models } when summary: true", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { summary: true },
    })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", models: ["z-ai/glm-5.2", "gpt-5"] },
    ])
    await h.close()
  })

  it("summary defaults models to [] when the lister didn't populate it", async () => {
    const { models, ...withoutModels } = FULL_ADAPTER
    void models
    const h = await harness(async () => [withoutModels as AdapterListEntry])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { summary: true },
    })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", models: [] },
    ])
    await h.close()
  })
})
