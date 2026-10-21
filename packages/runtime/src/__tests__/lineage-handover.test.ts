/**
 * Lineage handover - a successor session takes over a replaced session's
 * children.
 *
 * The bug it fixes: a persistent orchestrator (the "brain") is sometimes
 * replaced by a NEW session (restart, wallet change, continue-fresh). Its
 * children stay attached to the OLD `parentSessionId`, so the new brain
 * cannot drive them ("may only be driven by its owner") and they cannot
 * report to it ("no recorded parent").
 *
 * The mechanism is generic: the successor takes over the replaced session's
 * POSITION in the spawn tree, and the moved `parentSessionId` pointer moves
 * the whole contract with it - drive rights (the session-owner gate keys on
 * `parentSessionId`) and `message_parent` routing (it resolves the caller's
 * recorded parent).
 *
 * Covered here:
 *   - the successor drives the inherited children;
 *   - the inherited children report to the successor;
 *   - a third party is refused (drive AND adopt);
 *   - `agent_start.succeeds` declares the succession and hands the children
 *     over;
 *   - the `session_adopt` verb moves named children onto the declared
 *     successor;
 *   - the `session:lineage-handover` journal entry.
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { registerLineageTools } from "../lineage-tools.js"
import { continueAgentSessionFresh } from "../session-continue-fresh.js"
import { createSessionEventBus } from "../session-event-bus.js"
import {
  checkAdoptAuthority,
  checkSuccessorDeclaration,
  handoverLineage,
} from "../lineage-handover.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

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
  label?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(label ? { label } : {}),
  })
}

function makeResolver() {
  const startSession = vi.fn(async (_opts: unknown) => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as never,
    commandPreview: "mock-adapter",
  })
  return { resolveAgentAdapter, startSession }
}

async function agentHarness(opts: {
  registry: SessionsRegistry
  callerSessionId?: string
  resolveAgentAdapter?: AgentAdapterResolver
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

async function lineageHarness(opts: { registry: SessionsRegistry; callerSessionId?: string }) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerLineageTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
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

describe("lineage handover - the successor drives the inherited children", () => {
  it("re-parents the live children and hands the successor their drive rights", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const executor = spawnNode(registry, brain.id, "executor")
    const successor = spawnNode(registry, undefined, "brain-2")

    // The handover itself (what continue-fresh / `agent_start.succeeds` run).
    const outcome = handoverLineage({
      registry,
      from: brain.id,
      to: successor.id,
      reason: "continue-fresh",
      actor: "daemon",
    })

    expect(outcome.adopted.sort()).toEqual([supervisor.id, executor.id].sort())
    expect(registry.get(supervisor.id)?.parentSessionId).toBe(successor.id)
    expect(registry.get(executor.id)?.parentSessionId).toBe(successor.id)
    // The declaration is persisted on both rows - it is what authorizes
    // `session_adopt` later.
    expect(registry.get(brain.id)?.succeededBy).toBe(successor.id)
    expect(registry.get(successor.id)?.succeeds).toBe(brain.id)

    // The successor can now DRIVE the inherited children.
    const h = await agentHarness({ registry, callerSessionId: successor.id })
    try {
      const ok = await h.client.callTool({
        name: "agent_prompt",
        arguments: { sessionId: supervisor.id, prompt: "go" },
      })
      expect(isError(ok)).toBeFalsy()
      expect(JSON.parse(textOf(ok))).toMatchObject({ ok: true })
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("the inherited children report UP to the successor (`message_parent`)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, undefined, "brain-2")
    handoverLineage({ registry, from: brain.id, to: successor.id, reason: "continue-fresh", actor: "daemon" })

    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await agentHarness({ registry, callerSessionId: supervisor.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "done: the supervisor's job is finished" },
      })
      expect(isError(result)).toBeFalsy()
      const body = JSON.parse(textOf(result))
      // The report lands on the SUCCESSOR, not on the replaced row.
      expect(body.parentSessionId).toBe(successor.id)
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue.mock.calls[0]![0]).toBe(successor.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("a THIRD party is refused: it cannot drive the inherited child nor adopt it", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, undefined, "brain-2")
    handoverLineage({ registry, from: brain.id, to: successor.id, reason: "continue-fresh", actor: "daemon" })

    const stranger = await agentHarness({ registry, callerSessionId: "sess_stranger" })
    try {
      const refused = await stranger.client.callTool({
        name: "agent_prompt",
        arguments: { sessionId: supervisor.id, prompt: "go" },
      })
      expect(isError(refused)).toBe(true)
      expect(textOf(refused)).toContain("may only be driven by its owner")
    } finally {
      await stranger.close()
    }

    // `session_adopt` - the stranger is neither the operator nor the
    // declared successor.
    const adopter = await lineageHarness({ registry, callerSessionId: "sess_stranger" })
    try {
      const refusedAdopt = await adopter.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(isError(refusedAdopt)).toBe(true)
      expect(textOf(refusedAdopt)).toContain("DECLARED successor")
      // Nothing moved.
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(successor.id)
    } finally {
      await adopter.close()
    }
    registry.shutdown()
  })

  it("the replaced session itself loses the drive rights it used to have", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, undefined, "brain-2")
    handoverLineage({ registry, from: brain.id, to: successor.id, reason: "continue-fresh", actor: "daemon" })

    const old = await agentHarness({ registry, callerSessionId: brain.id })
    try {
      const refused = await old.client.callTool({
        name: "agent_prompt",
        arguments: { sessionId: supervisor.id, prompt: "go" },
      })
      expect(isError(refused)).toBe(true)
    } finally {
      await old.close()
    }
    registry.shutdown()
  })
})

describe("lineage handover - the `session:lineage-handover` journal entry", () => {
  it("records who handed over to whom, and which children moved", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, sessionEvents })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, undefined, "brain-2")

    const events: Array<Record<string, unknown>> = []
    sessionEvents.on("session:lineage-handover", ev => {
      events.push(ev as unknown as Record<string, unknown>)
    })

    handoverLineage({
      registry,
      from: brain.id,
      to: successor.id,
      reason: "continue-fresh",
      actor: "daemon",
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "session:lineage-handover",
      sessionId: brain.id,
      successorSessionId: successor.id,
      adopted: [supervisor.id],
      reason: "continue-fresh",
      actor: "daemon",
    })
    registry.shutdown()
  })
})

describe("lineage handover - `agent_start.succeeds`", () => {
  it("declares the succession and hands the children over to the new session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const { resolveAgentAdapter } = makeResolver()

    const h = await agentHarness({ registry, resolveAgentAdapter })
    let newSessionId: string | undefined
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock-adapter", cwd: "/tmp", succeeds: brain.id, label: "brain-2" },
      })
      expect(isError(res)).toBe(false)
      const body = JSON.parse(textOf(res))
      newSessionId = body.id
      expect(body.succeeds).toBe(brain.id)
      expect(body.lineageHandover.adopted).toEqual([supervisor.id])
      // The child now belongs to the successor.
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(newSessionId)
      // The declaration is recorded on both rows.
      expect(registry.get(brain.id)?.succeededBy).toBe(newSessionId)
      expect(registry.get(newSessionId!)?.succeeds).toBe(brain.id)
    } finally {
      await h.close()
    }

    // The successor drives the inherited child.
    const successorHarness = await agentHarness({ registry, callerSessionId: newSessionId! })
    try {
      const ok = await successorHarness.client.callTool({
        name: "agent_prompt",
        arguments: { sessionId: supervisor.id, prompt: "go" },
      })
      expect(isError(ok)).toBeFalsy()
    } finally {
      await successorHarness.close()
    }
    registry.shutdown()
  })

  it("refuses a declaration made by an unrelated session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const { resolveAgentAdapter } = makeResolver()

    const stranger = await agentHarness({ registry, callerSessionId: "sess_stranger", resolveAgentAdapter })
    try {
      const res = await stranger.client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock-adapter", cwd: "/tmp", succeeds: brain.id },
      })
      expect(isError(res)).toBe(true)
      expect(textOf(res)).toContain("succeeds")
      // Nothing moved, and no session was created for the refused call.
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(brain.id)
      expect(registry.list().filter(s => s.succeeds === brain.id)).toHaveLength(0)
    } finally {
      await stranger.close()
    }
    registry.shutdown()
  })

  it("the replaced session itself may declare its successor", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const { resolveAgentAdapter } = makeResolver()

    const h = await agentHarness({ registry, callerSessionId: brain.id, resolveAgentAdapter })
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock-adapter", cwd: "/tmp", succeeds: brain.id },
      })
      expect(isError(res)).toBe(false)
      const body = JSON.parse(textOf(res))
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(body.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })
})

describe("lineage handover - `session_adopt`", () => {
  it("the declared successor adopts the named children", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const executor = spawnNode(registry, brain.id, "executor")
    const successor = spawnNode(registry, undefined, "brain-2")
    // The succession was declared (by a continue-fresh or an
    // `agent_start.succeeds`) - but the children have not moved yet.
    registry.setLineageSuccessor(brain.id, successor.id)

    const h = await lineageHarness({ registry, callerSessionId: successor.id })
    try {
      const res = await h.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(isError(res)).toBe(false)
      const body = JSON.parse(textOf(res))
      expect(body.adopted).toEqual([supervisor.id])
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(successor.id)
      // The unnamed child stays where it was.
      expect(registry.get(executor.id)?.parentSessionId).toBe(brain.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("the human operator may adopt too", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, undefined, "brain-2")
    registry.setLineageSuccessor(brain.id, successor.id)

    const h = await lineageHarness({ registry })
    try {
      const res = await h.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(isError(res)).toBe(false)
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(successor.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("refuses when no successor was declared for `from`", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")

    const h = await lineageHarness({ registry })
    try {
      const res = await h.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(isError(res)).toBe(true)
      expect(textOf(res)).toContain("no DECLARED successor")
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(brain.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })
})

describe("lineage handover - tree integrity", () => {
  it("never creates a cycle when the successor sits inside the moved child's subtree", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const successor = spawnNode(registry, supervisor.id, "brain-2")
    registry.setLineageSuccessor(brain.id, successor.id)

    const h = await lineageHarness({ registry, callerSessionId: successor.id })
    try {
      const res = await h.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(isError(res)).toBe(false)
      const body = JSON.parse(textOf(res))
      expect(body.adopted).toEqual([])
      expect(body.skipped).toEqual([supervisor.id])
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(brain.id)
      expect(registry.get(successor.id)?.parentSessionId).toBe(supervisor.id)
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("re-derives the depth of the whole moved subtree", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnNode(registry, undefined, "root")
    const mid = spawnNode(registry, root.id, "mid")
    const successor = spawnNode(registry, mid.id, "brain-2")
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const leaf = spawnNode(registry, supervisor.id, "leaf")
    // `spawnAgent` does not derive depth from the parent: normalize it.
    registry.reassignParent(mid.id, root.id)
    registry.reassignParent(successor.id, mid.id)
    registry.reassignParent(supervisor.id, brain.id)
    registry.reassignParent(leaf.id, supervisor.id)
    expect(registry.get(successor.id)?.depth).toBe(2)
    expect(registry.get(supervisor.id)?.depth).toBe(1)
    expect(registry.get(leaf.id)?.depth).toBe(2)
    registry.setLineageSuccessor(brain.id, successor.id)

    const h = await lineageHarness({ registry, callerSessionId: successor.id })
    try {
      const res = await h.client.callTool({
        name: "session_adopt",
        arguments: { from: brain.id, childIds: [supervisor.id] },
      })
      expect(JSON.parse(textOf(res)).adopted).toEqual([supervisor.id])
    } finally {
      await h.close()
    }
    expect(registry.get(supervisor.id)?.depth).toBe(3)
    expect(registry.get(leaf.id)?.depth).toBe(4)
    registry.shutdown()
  })

  it("surfaces a failed `succeeds` handover as a warning on the agent_start response", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    spawnNode(registry, brain.id, "supervisor")
    vi.spyOn(registry, "emitLineageHandover").mockImplementation(() => {
      throw new Error("boom")
    })
    const { resolveAgentAdapter } = makeResolver()

    const h = await agentHarness({ registry, resolveAgentAdapter })
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock-adapter", cwd: "/tmp", succeeds: brain.id },
      })
      expect(isError(res)).toBe(false)
      const body = JSON.parse(textOf(res))
      expect(body.lineageHandover).toBeUndefined()
      expect(body.warnings).toEqual([expect.stringContaining("lineage handover failed: boom")])
    } finally {
      await h.close()
    }
    registry.shutdown()
  })

  it("renders the `succeeds` help pointer instead of a literal template", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const h = await agentHarness({ registry })
    try {
      const { tools } = await h.client.listTools()
      const agentStart = tools.find(t => t.name === "agent_start")!
      const desc = (agentStart.inputSchema.properties as Record<string, { description?: string }>)
        .succeeds!.description!
      expect(desc).not.toContain("${")
    } finally {
      await h.close()
    }
    registry.shutdown()
  })
})

describe("lineage handover - continue-fresh hands the children over", () => {
  it("the fresh continuation takes over the retired row's children", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, undefined, "brain")
    const supervisor = spawnNode(registry, brain.id, "supervisor")
    const executor = spawnNode(registry, brain.id, "executor")
    // A continue-fresh needs a context-continuity policy on the row.
    const prev = registry.get(brain.id)!
    prev.contextContinuity = {
      mode: "auto",
      warnAtPct: 55,
      compactAtPct: 65,
      continueFreshAtPct: 75,
      hardStopAtPct: 90,
      goal: true,
      plan: true,
      decisions: true,
      changedFiles: true,
      gitStatus: true,
      tests: true,
      errors: true,
      risks: true,
      nextStep: true,
      config: true,
      label: "auto",
    }
    const { resolveAgentAdapter } = makeResolver()
    const baseDir = mkdtempSync(join(tmpdir(), "lineage-handover-"))
    try {
      const result = await continueAgentSessionFresh(
        { registry, resolveAgentAdapter },
        prev,
        { baseDir, askSource: false },
      )
      const fresh = result.descriptor
      expect(fresh.continuedFrom).toBe(brain.id)
      // The children moved to the continuation - the new brain can drive them
      // and they report to it.
      expect(registry.get(supervisor.id)?.parentSessionId).toBe(fresh.id)
      expect(registry.get(executor.id)?.parentSessionId).toBe(fresh.id)
      // The succession is declared on both rows.
      expect(registry.get(brain.id)?.succeededBy).toBe(fresh.id)
      expect(registry.get(fresh.id)?.succeeds).toBe(brain.id)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      registry.shutdown()
    }
  })
})

describe("lineage handover - the pure authority checks", () => {  const from = { id: "sess_brain", parentSessionId: "sess_owner" } as SessionDescriptor

  it("the operator, the replaced session and its owner may declare a successor", () => {
    expect(checkSuccessorDeclaration({ callerSessionId: undefined, from }).ok).toBe(true)
    expect(checkSuccessorDeclaration({ callerSessionId: "sess_brain", from }).ok).toBe(true)
    expect(checkSuccessorDeclaration({ callerSessionId: "sess_owner", from }).ok).toBe(true)
    expect(checkSuccessorDeclaration({ callerSessionId: "sess_child", from }).ok).toBe(false)
  })

  it("only the operator or the DECLARED successor may adopt", () => {
    expect(checkAdoptAuthority({ callerSessionId: undefined, from }).ok).toBe(true)
    expect(
      checkAdoptAuthority({ callerSessionId: "sess_next", from, successorId: "sess_next" }).ok,
    ).toBe(true)
    expect(checkAdoptAuthority({ callerSessionId: "sess_child", from, successorId: "sess_next" }).ok).toBe(false)
    expect(checkAdoptAuthority({ callerSessionId: "sess_next", from }).ok).toBe(false)
  })
})
