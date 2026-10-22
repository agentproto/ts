/**
 * `message_send` across the spawn tree: the SAME-WORKSPACE allowance
 * (`defaults.messaging.allowSameWorkspace`, default true).
 *
 * Today a session may only message a tree neighbour (its parent, its direct
 * children, and - with `allowSiblings` - a sibling). Two permanent agents of
 * the SAME workspace that are not neighbours (cousins: agents of different
 * branches of the spawn tree) are refused, which blocks consultations
 * between agents of one workspace. The allowance lifts exactly that refusal:
 * same non-empty `workspaceSlug` ⇒ allowed, even without a tree edge.
 *
 * The tree rules themselves are untouched: a different workspace, a missing
 * workspace, or `allowSameWorkspace: false` keep today's refusal.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerMessageTools } from "../message-tools.js"
import { sameWorkspace } from "../session-message.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

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
  parentSessionId: string | undefined,
  workspaceSlug: string,
  label?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug,
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(label ? { label } : {}),
    depth: parentSessionId ? 1 : 0,
  })
}

async function harness(opts: {
  registry: SessionsRegistry
  callerSessionId: string
  allowSameWorkspace?: boolean
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    callerSessionId: opts.callerSessionId,
    ...(opts.allowSameWorkspace !== undefined
      ? { allowSameWorkspace: opts.allowSameWorkspace }
      : {}),
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

/** A tree where `a1` (under `a`) and `b1` (under `b`) are COUSINS - not
 *  tree neighbours - so the tree gate refuses them by default. */
function cousinTree(registry: SessionsRegistry, aWorkspace: string, bWorkspace: string) {
  const root = spawnNode(registry, undefined, aWorkspace, "root")
  const a = spawnNode(registry, root.id, aWorkspace, "marketing-officer")
  const b = spawnNode(registry, root.id, bWorkspace, "pm-simone")
  const a1 = spawnNode(registry, a.id, aWorkspace, "marketing-officer-1")
  const b1 = spawnNode(registry, b.id, bWorkspace, "pm-simone-1")
  return { root, a, b, a1, b1 }
}

describe("message_send - same-workspace allowance", () => {
  it("allows a non-neighbour session of the SAME workspace (default)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = cousinTree(registry, "ws-acme", "ws-acme")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({ registry, callerSessionId: a1.id })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "can you sign off the launch copy?" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result)).ok).toBe(true)
      expect(enqueue).toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("allowSameWorkspace:false restores today's refusal (and names the flag)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = cousinTree(registry, "ws-acme", "ws-acme")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({ registry, callerSessionId: a1.id, allowSameWorkspace: false })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "can you sign off the launch copy?" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("allowSameWorkspace")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("refuses a non-neighbour session of a DIFFERENT workspace", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = cousinTree(registry, "ws-acme", "ws-other")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({ registry, callerSessionId: a1.id })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("refuses when the workspace slug is missing on either side", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = cousinTree(registry, "ws-acme", "ws-acme")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({ registry, callerSessionId: a1.id })
    // Blank out the recipient's workspace slug (a descriptor without one).
    const blanked = registry.get(b1.id)!
    blanked.workspaceSlug = ""
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("tree rules are unchanged: parent and direct child still allowed, sibling still gated", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnNode(registry, undefined, "ws-acme", "root")
    const child = spawnNode(registry, root.id, "ws-acme", "child")
    const sib = spawnNode(registry, root.id, "ws-acme", "sibling")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({ registry, callerSessionId: child.id })
    try {
      const up = await h.client.callTool({
        name: "message_send",
        arguments: { to: root.id, text: "hi" },
      })
      expect(isError(up)).toBeFalsy()
      const down = await h.client.callTool({
        name: "message_send",
        arguments: { to: "parent", text: "hi" },
      })
      expect(isError(down)).toBeFalsy()
      const toSibling = await h.client.callTool({
        name: "message_send",
        arguments: { to: sib.id, text: "hi" },
      })
      expect(isError(toSibling)).toBe(true)
    } finally {
      await h.close()
    }
  })
})

describe("sameWorkspace", () => {
  it("same non-empty slug ⇒ true; different, missing or blank ⇒ false", () => {
    expect(sameWorkspace({ id: "a", workspaceSlug: "ws" }, { id: "b", workspaceSlug: "ws" })).toBe(true)
    expect(sameWorkspace({ id: "a", workspaceSlug: "ws" }, { id: "b", workspaceSlug: "other" })).toBe(false)
    expect(sameWorkspace({ id: "a", workspaceSlug: "ws" }, { id: "b" })).toBe(false)
    expect(sameWorkspace({ id: "a", workspaceSlug: "" }, { id: "b", workspaceSlug: "" })).toBe(false)
    expect(sameWorkspace(undefined, { id: "b", workspaceSlug: "ws" })).toBe(false)
  })
})
