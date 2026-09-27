/**
 * `agent_prompt`'s `prompt` field used to be `z.string()` only, even though
 * the registry (`enqueuePrompt`/`sendPrompt`) and the HTTP twin
 * (`POST /sessions/:id/prompt`) already accept a content block or block
 * array for a multimodal turn. This closes that gap: the MCP tool now
 * validates and forwards the same loose shape, so a host (e.g. session-chat
 * pasting an image into its composer) can reach a live session through MCP
 * exactly as it could over HTTP.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

/** Completes its turn immediately, recording exactly what it received. */
function recordingAgentSession(): { agent: AgentSessionLike; received: unknown[] } {
  const received: unknown[] = []
  const agent: AgentSessionLike = {
    sessionId: "recording-session",
    async *send(message: unknown) {
      received.push(message)
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, received }
}

async function makeMcpClient(registry: ReturnType<typeof createSessionsRegistry>) {
  const server = new McpServer({ name: "agent-prompt-content-block-server", version: "0.0.0" })
  registerAgentTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-prompt-content-block-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("agent_prompt (MCP): content-block prompt", () => {
  it("accepts a content-block array (text + image) and forwards it verbatim, not stringified", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, received } = recordingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    const blocks = [
      { type: "text", text: "what's wrong in this screenshot?" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]
    const result = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: blocks },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(String(result.content?.[0]?.text)).ok).toBe(true)
    await vi_waitForOne(received)
    expect(received).toEqual([blocks])

    client.close()
    registry.shutdown()
  })

  it("accepts a single content block (not wrapped in an array) and forwards it verbatim", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, received } = recordingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    const block = { type: "image", data: "AAAA", mimeType: "image/png" }
    const result = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: block },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }

    expect(result.isError).toBeUndefined()
    await vi_waitForOne(received)
    expect(received).toEqual([block])

    client.close()
    registry.shutdown()
  })

  it("still rejects an empty string, exactly as before", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent } = recordingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    const result = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "" },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }
    expect(result.isError).toBe(true)
    expect(String(result.content?.[0]?.text)).toContain("Input validation error")

    client.close()
    registry.shutdown()
  })
})

describe("agent_start (MCP): content-block initial prompt", () => {
  it("accepts a content-block array as the initial prompt and forwards it verbatim to startSession's live session", async () => {
    const { agent, received } = recordingAgentSession()
    const startSession = async () => agent
    const registry = createSessionsRegistry({ persist: false })
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: startSession as any,
      commandPreview: "mock-adapter",
    })
    const server = new McpServer({ name: "agent-start-content-block-server", version: "0.0.0" })
    registerAgentTools(server, { registry, resolveAgentAdapter })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "agent-start-content-block-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const blocks = [
      { type: "text", text: "help me caption this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]
    const result = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cwd: "/tmp", prompt: blocks },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(String(result.content?.[0]?.text))
    expect(parsed.id).toMatch(/^sess_/)
    await vi_waitForOne(received)
    expect(received).toEqual([blocks])

    client.close()
    registry.shutdown()
  })
})

/** `agent_prompt` fires the turn fire-and-forget (it resolves once the turn
 *  is ADMITTED, not once it's drained) — poll briefly for the recording
 *  session's `send()` to have actually run rather than asserting instantly. */
async function vi_waitForOne(received: unknown[]): Promise<void> {
  for (let i = 0; i < 50 && received.length === 0; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}
