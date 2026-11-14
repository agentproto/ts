/**
 * `message_send` across WORKSPACES: the PEER-GROUP allowance
 * (`defaults.messaging.peerGroups`).
 *
 * The same-workspace allowance (`defaults.messaging.allowSameWorkspace`)
 * only links two sessions of ONE workspace. Real deployments need more: the
 * Pygmalion brain and its copywriter live in `app-agentik-pygmalion`, while
 * the PMs and the OVH supervisor live in `agentik-studio` - the two families
 * must be able to talk, but an unrelated workspace must not.
 *
 * `defaults.messaging.peerGroups` is an array of arrays of workspace slugs:
 * two sessions are peers when both workspace slugs belong to the SAME group.
 * The allowance is independent of `allowSameWorkspace` (a group link holds
 * even when the same-workspace rule is off) and it is narrow: a session
 * without a workspace slug is never a peer, and a pair outside every group
 * keeps today's refusal.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerMessageTools } from "../message-tools.js"
import { samePeerGroup } from "../session-message.js"
import { findConfigKey, validateConfigKeyType } from "../config-schema.js"
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
  peerGroups?: string[][]
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    callerSessionId: opts.callerSessionId,
    ...(opts.allowSameWorkspace !== undefined
      ? { allowSameWorkspace: opts.allowSameWorkspace }
      : {}),
    ...(opts.peerGroups ? { peerGroups: opts.peerGroups } : {}),
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

/** Two COUSIN branches in DIFFERENT workspaces: no tree edge, so the tree
 *  gate refuses them; only a peer group can link them. */
function crossWorkspaceCousins(registry: SessionsRegistry, aWorkspace: string, bWorkspace: string) {
  const root = spawnNode(registry, undefined, aWorkspace, "root")
  const a = spawnNode(registry, root.id, aWorkspace, "brain")
  const b = spawnNode(registry, root.id, bWorkspace, "pm")
  const a1 = spawnNode(registry, a.id, aWorkspace, "copywriter")
  const b1 = spawnNode(registry, b.id, bWorkspace, "supervisor")
  return { root, a, b, a1, b1 }
}

const STUDIO = "agentik-studio"
const PYGMALION = "app-agentik-pygmalion"

describe("message_send - peer groups", () => {
  it("allows a cross-workspace pair whose slugs are in the same peer group", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = crossWorkspaceCousins(registry, PYGMALION, STUDIO)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: a1.id,
      peerGroups: [[STUDIO, PYGMALION]],
    })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "the launch copy is ready" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result)).ok).toBe(true)
      expect(enqueue).toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("refuses a cross-workspace pair that is in no peer group (and names peerGroups)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = crossWorkspaceCousins(registry, PYGMALION, STUDIO)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: a1.id,
      peerGroups: [[STUDIO, "other-workspace"]],
    })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("peerGroups")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("the default (no peer groups) refuses a cross-workspace pair", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = crossWorkspaceCousins(registry, PYGMALION, STUDIO)
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

  it("a slug in two groups only links within each group", async () => {
    const registry = createSessionsRegistry({ persist: false })
    // Three cousins, one per workspace: "shared" sits in both groups,
    // "only-a" only in group 1, "only-b" only in group 2 - so only-a and
    // only-b must NOT be linked.
    const root = spawnNode(registry, undefined, STUDIO, "root")
    const branchA = spawnNode(registry, root.id, "only-a", "branch-a")
    const branchB = spawnNode(registry, root.id, "shared", "branch-b")
    const branchC = spawnNode(registry, root.id, "only-b", "branch-c")
    const onlyA = spawnNode(registry, branchA.id, "only-a", "only-a")
    const shared = spawnNode(registry, branchB.id, "shared", "shared")
    const onlyB = spawnNode(registry, branchC.id, "only-b", "only-b")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: onlyA.id,
      peerGroups: [
        ["shared", "only-a"],
        ["shared", "only-b"],
      ],
    })
    try {
      const toShared = await h.client.callTool({
        name: "message_send",
        arguments: { to: shared.id, text: "hi" },
      })
      expect(isError(toShared)).toBeFalsy()
      const toOtherGroup = await h.client.callTool({
        name: "message_send",
        arguments: { to: onlyB.id, text: "hi" },
      })
      expect(isError(toOtherGroup)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it("refuses when a workspace slug is missing on either side", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = crossWorkspaceCousins(registry, PYGMALION, STUDIO)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: a1.id,
      peerGroups: [[STUDIO, PYGMALION]],
    })
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

  it("a peer group holds even when allowSameWorkspace is off", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { a1, b1 } = crossWorkspaceCousins(registry, PYGMALION, STUDIO)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: a1.id,
      allowSameWorkspace: false,
      peerGroups: [[STUDIO, PYGMALION]],
    })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: b1.id, text: "hello" },
      })
      expect(isError(result)).toBeFalsy()
      expect(enqueue).toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("tree rules are unchanged: parent still allowed, a sibling outside every peer group still gated", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnNode(registry, undefined, STUDIO, "root")
    const child = spawnNode(registry, root.id, STUDIO, "child")
    const sib = spawnNode(registry, root.id, "unrelated-workspace", "sibling")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: child.id,
      peerGroups: [[STUDIO, PYGMALION]],
    })
    try {
      const up = await h.client.callTool({
        name: "message_send",
        arguments: { to: root.id, text: "hi" },
      })
      expect(isError(up)).toBeFalsy()
      const toSibling = await h.client.callTool({
        name: "message_send",
        arguments: { to: sib.id, text: "hi" },
      })
      expect(isError(toSibling)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it("a peer group overrides a denied sibling edge and records relation `granted`", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnNode(registry, undefined, STUDIO, "root")
    const child = spawnNode(registry, root.id, STUDIO, "child")
    const sib = spawnNode(registry, root.id, PYGMALION, "sibling")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: child.id,
      peerGroups: [[STUDIO, PYGMALION]],
    })
    try {
      const toSibling = await h.client.callTool({
        name: "message_send",
        arguments: { to: sib.id, text: "hi" },
      })
      expect(isError(toSibling)).toBeFalsy()
      expect(JSON.parse(textOf(toSibling)).relation).toBe("granted")
      expect(enqueue).toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})

describe("config schema - defaults.messaging.peerGroups", () => {
  it("accepts an array of arrays of non-empty strings", () => {
    expect(
      validateConfigKeyType("defaults.messaging.peerGroups", [[STUDIO, PYGMALION]]),
    ).toEqual({ ok: true })
    expect(validateConfigKeyType("defaults.messaging.peerGroups", [])).toEqual({ ok: true })
  })

  it("rejects a non-array and an empty string", () => {
    expect(validateConfigKeyType("defaults.messaging.peerGroups", "studio").ok).toBe(false)
    expect(validateConfigKeyType("defaults.messaging.peerGroups", [STUDIO]).ok).toBe(false)
    expect(validateConfigKeyType("defaults.messaging.peerGroups", [[STUDIO, ""]]).ok).toBe(false)
  })

  it("is a hot, writable key with the empty-group default", () => {
    const entry = findConfigKey("defaults.messaging.peerGroups")
    expect(entry).toBeDefined()
    expect(entry?.apply).toBe("hot")
    expect(entry?.writable).toBe(true)
    expect(entry?.default).toEqual([])
  })
})

describe("samePeerGroup", () => {
  it("links two slugs of the same group only", () => {
    const groups = [["a", "b"], ["c", "d"]]
    expect(samePeerGroup({ id: "x", workspaceSlug: "a" }, { id: "y", workspaceSlug: "b" }, groups)).toBe(true)
    expect(samePeerGroup({ id: "x", workspaceSlug: "a" }, { id: "y", workspaceSlug: "c" }, groups)).toBe(false)
    expect(samePeerGroup({ id: "x", workspaceSlug: "a" }, { id: "y", workspaceSlug: "b" }, [])).toBe(false)
    expect(samePeerGroup({ id: "x", workspaceSlug: "a" }, { id: "y", workspaceSlug: "b" }, undefined)).toBe(false)
  })

  it("a missing or blank slug is never a peer", () => {
    const groups = [["a", "b"]]
    expect(samePeerGroup({ id: "x" }, { id: "y", workspaceSlug: "b" }, groups)).toBe(false)
    expect(samePeerGroup({ id: "x", workspaceSlug: "" }, { id: "y", workspaceSlug: "b" }, groups)).toBe(false)
    expect(samePeerGroup(undefined, { id: "y", workspaceSlug: "b" }, groups)).toBe(false)
  })
})
