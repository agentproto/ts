/**
 * agent_start's `commandSandbox` field (PR 6b) — end-to-end over a real MCP
 * transport, confirming zod actually declares the field (PR 6a shipped the
 * plumbing but explicitly left it off the public schema — "zod strips the
 * extra field") and that it reaches the adapter resolver's `startSession`
 * unmodified, distinct from (and independent of) the AIP-36 `sandbox` field.
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

  const server = new McpServer({ name: "agent-start-command-sandbox-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-command-sandbox-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

function mockSession(id: string) {
  return {
    sessionId: id,
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }
}

describe("agent_start — commandSandbox field", () => {
  it("forwards `commandSandbox` to the adapter resolver's startSession", async () => {
    const startSession = vi.fn(async () => mockSession("adapter_cmdsbx_test"))
    const { client } = await setup(startSession)

    const result = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", commandSandbox: "workspace" },
      }),
    )
    expect(result.id).toMatch(/^sess_/)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ commandSandbox: "workspace" }),
    )
  })

  it("rejects an unknown commandSandbox value — not a passthrough string field", async () => {
    const startSession = vi.fn(async () => mockSession("adapter_cmdsbx_bad"))
    const { client } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cwd: "/tmp", commandSandbox: "bogus" },
    })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(startSession).not.toHaveBeenCalled()
  })

  it("omits `commandSandbox` entirely when not supplied — no regression for the default path", async () => {
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => mockSession("adapter_no_cmdsbx"))
    const { client } = await setup(startSession)

    await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cwd: "/tmp" },
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    const calledWith = startSession.mock.calls[0]![0]
    expect("commandSandbox" in calledWith).toBe(false)
  })

  it("`commandSandbox` and the AIP-36 `sandbox` field are independent — setting one never implies or blocks the other", async () => {
    const startSession = vi.fn(async () => mockSession("adapter_both_axes"))
    const { client } = await setup(startSession)

    const result = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", commandSandbox: "strict" },
      }),
    )
    expect(result.id).toMatch(/^sess_/)
    // No `sandbox` was passed — commandSandbox alone must not route through
    // the AIP-36 sandbox-provider boot path (no provider resolver wired here
    // at all, so any accidental coupling would have thrown sandbox_provider_not_found).
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ commandSandbox: "strict" }),
    )
  })
})
