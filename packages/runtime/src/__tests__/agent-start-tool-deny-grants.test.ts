/**
 * T3b scope 1: a spawn from an AGENT.md records the `tool:invoke` deny grants
 * of its `tools` deny items on the session descriptor (`toolDenyGrants`), once,
 * at spawn. A manifest with no deny item records nothing (no field at all), so
 * the dispatch gate never evaluates that session. Temp HOME and dirs only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

const fakeSession = (): AgentSessionLike => ({
  sessionId: "adapter_tool_deny_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

async function setup() {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: vi.fn(async () => fakeSession()) as any,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "tool-deny-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "tool-deny-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const start = async (agentPath: string) =>
    parseToolJson(await client.callTool({ name: "agent_start", arguments: { adapter: "mock", cwd: home, agentPath } }))
  return { registry, start }
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-tool-deny-grants-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

async function writeAgent(id: string, toolsYaml: string[]): Promise<string> {
  const dir = join(home, ".agents", id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    ["---", "schema: agent/v1", `id: ${id}`, "description: probe", "model: test-model", ...toolsYaml, "---", "", "You are a probe."].join("\n"),
    "utf8",
  )
  return path
}

describe("agent_start from an AGENT.md records its tool deny grants on the descriptor", () => {
  it("records one tool:invoke deny per deny entry of an mcp item", async () => {
    const path = await writeAgent("denier", [
      "tools:",
      "  - kind: mcp",
      "    server: agentproto",
      "    deny: [cron_create, cron_delete]",
      "  - kind: mcp",
      "    server: agentpush",
      "    deny: [send_message]",
    ])
    const { registry, start } = await setup()
    const body = await start(path)
    expect(registry.get(body.id)?.toolDenyGrants).toEqual([
      { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/cron_create" }] },
      { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/cron_delete" }] },
      { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentpush/send_message" }] },
    ])
  })

  it("records no field for a manifest with allow-only items, bare tool names, or no tools", async () => {
    const { registry, start } = await setup()
    for (const [id, tools] of [
      ["allowonly", ["tools:", "  - kind: mcp", "    server: agentproto", "    allow: [cron_list]"]],
      ["bare", ["tools: [write_agent_data]"]],
      ["none", []],
    ] as const) {
      const body = await start(await writeAgent(id, [...tools]))
      const desc = registry.get(body.id)
      expect(desc, id).toBeDefined()
      expect("toolDenyGrants" in desc!, id).toBe(false)
    }
  })

  it("records no field for a spawn with no AGENT.md", async () => {
    const { registry } = await setup()
    const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: home, agentSession: fakeSession(), adapterSlug: "mock" })
    expect("toolDenyGrants" in registry.get(desc.id)!).toBe(false)
  })
})
