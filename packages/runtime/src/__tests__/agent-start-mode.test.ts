/**
 * agent_start's `mode` field (harness-parity item 4) — end-to-end over a
 * real MCP transport, confirming it reaches the adapter resolver's
 * `startSession` unmodified so it can flow into `composeSpawn`'s mode
 * patch (see driver-agent-cli/manifest/compose.ts).
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(startSession: ReturnType<typeof vi.fn>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter",
  })

  const server = new McpServer({ name: "agent-start-mode-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-mode-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

describe("agent_start — mode field", () => {
  it("forwards `mode` to the adapter resolver's startSession", async () => {
    const startSession = vi.fn(async () => ({
      sessionId: "adapter_mode_test",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }))
    const { client } = await setup(startSession)

    const result = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", mode: "plan" },
      }),
    )
    expect(result.id).toMatch(/^sess_/)
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }))
  })

  it("omits `mode` entirely when not supplied — no regression for the default path", async () => {
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => ({
      sessionId: "adapter_no_mode_test",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }))
    const { client } = await setup(startSession)

    await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cwd: "/tmp" },
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    const calledWith = startSession.mock.calls[0]![0]
    expect("mode" in calledWith).toBe(false)
  })

  it("surfaces a RuntimeConfigError-style failure as agent_start isError, not a crash", async () => {
    const startSession = vi.fn(async () => {
      throw new Error("[unknown_mode at config.mode] Mode 'bogus' is not declared by manifest 'hermes'. Known modes: (none)")
    })
    const { client } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "hermes", cwd: "/tmp", mode: "bogus" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("unknown_mode")
  })
})

describe("agent_start — boardId field", () => {
  it("passes `boardId` through the MCP schema onto the descriptor's meta", async () => {
    const startSession = vi.fn(async () => ({
      sessionId: "adapter_boardid_test",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }))
    const { client } = await setup(startSession)

    const result = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", boardId: "cowork:main" },
      }),
    )
    expect(result.id).toMatch(/^sess_/)
    // The stamp the task ledger's board resolution reads (task-ledger.ts).
    expect(result.meta).toEqual({ boardId: "cowork:main" })
  })
})
