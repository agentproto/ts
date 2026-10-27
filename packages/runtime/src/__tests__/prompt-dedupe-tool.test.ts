/**
 * `agent_prompt` carries `dedupeKey` through to `enqueuePrompt`, does not
 * note a duplicate as a sent prompt, and renders the duplicate result
 * without a queued hint while leaving every normal field untouched.
 */
import { describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

function countingAgent(sessionId = "dedupe-tool-session"): {
  agent: AgentSessionLike
  prompts: unknown[]
} {
  const prompts: unknown[] = []
  const agent: AgentSessionLike = {
    sessionId,
    async *send(message) {
      prompts.push(message)
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, prompts }
}

function hangingAgent(sessionId = "dedupe-tool-session"): {
  agent: AgentSessionLike
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const agent: AgentSessionLike = {
    sessionId,
    async *send() {
      await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, release }
}

async function makeMcpClient(registry: ReturnType<typeof createSessionsRegistry>) {
  const server = new McpServer({ name: "prompt-dedupe-server", version: "0.0.0" })
  registerAgentTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "prompt-dedupe-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

type ToolResult = { isError?: boolean; content?: { type: string; text: string }[] }

function bodyOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(String(result.content?.[0]?.text)) as Record<string, unknown>
}

describe("agent_prompt dedupeKey", () => {
  it("passes the key through and keeps the normal result object byte-identical", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent } = countingAgent()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)
    const spy = vi.spyOn(registry, "enqueuePrompt")

    const result = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "hello", dedupeKey: "tool-key" },
    })) as ToolResult

    expect(spy).toHaveBeenLastCalledWith(
      desc.id,
      "hello",
      expect.objectContaining({ dedupeKey: "tool-key" }),
    )
    const body = bodyOf(result)
    expect(body.delivery).toBe("delivered")
    expect(Object.keys(body)).toEqual([
      "ok",
      "pending",
      "delivery",
      "deliveredAt",
      "sessionId",
      "queued",
    ])
    expect(body.duplicate).toBeUndefined()

    client.close()
    registry.shutdown()
  })

  it("a duplicate renders delivery duplicate with no hint and is not noted as a prompt", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent } = hangingAgent()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)
    const note = vi.spyOn(registry, "noteSessionPrompt")

    void (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    }))
    const first = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second", dedupeKey: "tool-dup" },
    })) as ToolResult
    expect(note).toHaveBeenCalledTimes(2)
    const firstQueueId = bodyOf(first).queueId

    const duplicate = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "third", dedupeKey: "tool-dup" },
    })) as ToolResult

    expect(note).toHaveBeenCalledTimes(2)
    const body = bodyOf(duplicate)
    expect(body).toMatchObject({
      pending: false,
      delivery: "duplicate",
      duplicate: true,
      queueId: firstQueueId,
    })
    expect(body.hint).toBeUndefined()

    client.close()
    registry.shutdown()
  })
})
