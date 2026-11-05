/**
 * `mcp.noCallerIdentity`: what the MCP gateway does with a tool call that
 * carries NO caller identity (Claude Code / Claude Desktop connecting
 * straight to the daemon, with neither a scoped orchestrator scope nor a
 * `?callerSessionId=`).
 *
 * Default `block` is today's behaviour. `accept` lets ONLY `message_send`
 * act: it goes out as the anonymous `claude-code` sender, never as a
 * session and with no ACL elevation. `ask` parks that send on a human
 * approval. `message_parent`, `message_reply` and the inbox reads keep
 * refusing because they need a real identity to act AS.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { registerMessageTools } from "../message-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { renderSessionMessages, type SessionMessage } from "../session-message.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { agentprotoConfigSchema } from "../config-schema.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(
  registry: SessionsRegistry,
  parentSessionId?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth: parentSessionId ? 1 : 0,
  })
}

async function messageHarness(opts: {
  registry: SessionsRegistry
  noCallerIdentity?: "block" | "ask" | "accept"
  requestAnonymousMessageApproval?: (d: unknown) => Promise<boolean>
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
    ...(opts.requestAnonymousMessageApproval
      ? { requestAnonymousMessageApproval: opts.requestAnonymousMessageApproval }
      : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

async function agentHarness(opts: {
  registry: SessionsRegistry
  noCallerIdentity?: "block" | "ask" | "accept"
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry: opts.registry,
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

function bodyOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result))
}

describe("mcp.noCallerIdentity: message_send", () => {
  it("block (default) keeps refusing an identity-less send", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const target = spawnNode(registry)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await messageHarness({ registry })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: target.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(bodyOf(result).error).toBe("no_caller_identity")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("accept sends as the anonymous claude-code, never as a session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const target = spawnNode(registry)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await messageHarness({ registry, noCallerIdentity: "accept" })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: target.id, text: "hello from a desktop app" },
      })
      expect(isError(result)).toBeFalsy()
      const payload = bodyOf(result)
      expect(payload.ok).toBe(true)
      expect(payload.anonymous).toBe(true)
      expect(payload.from).toBe("claude-code")
      expect(enqueue).toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("a declared replyTo is rendered into the recipient's text", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const target = spawnNode(registry)
    const send = vi.spyOn(registry, "sendMessage")
    const h = await messageHarness({ registry, noCallerIdentity: "accept" })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: {
          to: target.id,
          text: "hello",
          replyTo: "cc:my-desktop-session",
        },
      })
      expect(isError(result)).toBeFalsy()
      const msg = send.mock.calls.at(-1)![0] as SessionMessage
      expect(msg.replyAddress).toBe("cc:my-desktop-session")
      expect(renderSessionMessages([msg])).toContain("reply to: cc:my-desktop-session")
    } finally {
      await h.close()
    }
  })

  it("rejects a replyTo that is neither a message id nor a declared address", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const target = spawnNode(registry)
    const h = await messageHarness({ registry, noCallerIdentity: "accept" })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: target.id, text: "hello", replyTo: "not an id!!" },
      })
      expect(isError(result)).toBe(true)
      expect(bodyOf(result).error).toBe("invalid_reply_to")
    } finally {
      await h.close()
    }
  })

  it("ask refuses when the approval is denied, and sends when approved", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const target = spawnNode(registry)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })

    const denied = await messageHarness({
      registry,
      noCallerIdentity: "ask",
      requestAnonymousMessageApproval: async () => false,
    })
    try {
      const result = await denied.client.callTool({
        name: "message_send",
        arguments: { to: target.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(bodyOf(result).error).toBe("anonymous_not_approved")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await denied.close()
    }

    const approval = vi.fn(async () => true)
    const approved = await messageHarness({
      registry,
      noCallerIdentity: "ask",
      requestAnonymousMessageApproval: approval,
    })
    try {
      const result = await approved.client.callTool({
        name: "message_send",
        arguments: { to: target.id, text: "hello" },
      })
      expect(isError(result)).toBeFalsy()
      expect(bodyOf(result).anonymous).toBe(true)
      expect(approval).toHaveBeenCalledOnce()
    } finally {
      await approved.close()
    }
  })
})

describe("mcp.noCallerIdentity: tools that need a real identity", () => {
  it("message_parent still refuses under accept", async () => {
    const registry = createSessionsRegistry({ persist: false })
    spawnNode(registry)
    const h = await agentHarness({ registry, noCallerIdentity: "accept" })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hi parent" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("caller")
    } finally {
      await h.close()
    }
  })

  it("inbox reads return an empty result plus a hint under accept", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const h = await messageHarness({ registry, noCallerIdentity: "accept" })
    try {
      const listed = await h.client.callTool({ name: "inbox_list", arguments: {} })
      expect(isError(listed)).toBeFalsy()
      expect(bodyOf(listed).anonymous).toBe(true)
      expect(bodyOf(listed).messages).toEqual([])
      expect(String(bodyOf(listed).hint)).toContain("replyTo")

      const acked = await h.client.callTool({
        name: "inbox_ack",
        arguments: { ids: "all" },
      })
      expect(isError(acked)).toBeFalsy()
      expect(bodyOf(acked).acked).toEqual([])
    } finally {
      await h.close()
    }
  })
})

describe("mcp.noCallerIdentity: config", () => {
  it("accepts each policy and defaults an absent key", () => {
    expect(agentprotoConfigSchema.parse({ mcp: { noCallerIdentity: "accept" } }).mcp).toEqual({
      noCallerIdentity: "accept",
    })
    expect(agentprotoConfigSchema.parse({}).mcp).toBeUndefined()
    expect(() =>
      agentprotoConfigSchema.parse({ mcp: { noCallerIdentity: "allow-everything" } }),
    ).toThrow()
  })
})
