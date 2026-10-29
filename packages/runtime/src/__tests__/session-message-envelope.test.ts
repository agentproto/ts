/**
 * AIP-46 envelope: `from.relation` is `granted` (not `peer`) when no tree
 * edge holds and an allowance admitted the send, and `from.agentSlug` names
 * the sender's AIP-42 agent. Persisted `peer` records stay readable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import {
  createSessionMessage,
  isMessageAllowed,
  matchesMessageFilter,
  messageFrom,
  normalizeMessageRelation,
  renderSessionMessage,
  resolveEffectiveRelation,
  resolveMessageAcl,
  type SessionMessage,
} from "../session-message.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"

function quiet(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: 1,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function toolsAs(
  registry: SessionsRegistry,
  callerSessionId: string,
  extra: { messagingAllowSiblings?: boolean; messagingPeerGroups?: string[][] } = {},
) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, { registry, callerSessionId, ...extra })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(ct)
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }
      return JSON.parse(r.content[0]!.text) as Record<string, unknown>
    },
    close: () => client.close(),
  }
}

describe("envelope relation: granted", () => {
  let tmp: string
  let registry: SessionsRegistry
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "envelope-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawn = (
    label: string,
    workspaceSlug: string,
    extra: { parentSessionId?: string; meta?: Record<string, string> } = {},
  ) =>
    registry.spawnAgent({
      workspaceSlug,
      cwd: "/tmp",
      agentSession: quiet(`acp-${label}`),
      adapterSlug: "mock",
      label,
      ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId, depth: 1 } : {}),
      ...(extra.meta ? { meta: extra.meta } : {}),
    })

  it("a same-workspace pair with no tree edge is delivered as `granted`", async () => {
    const a = spawn("a", "w")
    const b = spawn("b", "w")
    const asA = await toolsAs(registry, a.id)
    const sent = await asA.call("message_send", { to: b.id, text: "hi", urgency: "fyi" })
    expect(sent).toMatchObject({ ok: true, relation: "granted" })
    expect(registry.listInbox(b.id)![0]!.from).toMatchObject({ sessionId: a.id, relation: "granted" })
    await asA.close()
  })

  it("a peer-group pair is delivered as `granted`", async () => {
    const a = spawn("a", "ws1")
    const b = spawn("b", "ws2")
    const asA = await toolsAs(registry, a.id, { messagingPeerGroups: [["ws1", "ws2"]] })
    const sent = await asA.call("message_send", { to: b.id, text: "hi", urgency: "fyi" })
    expect(sent).toMatchObject({ ok: true, relation: "granted" })
    expect(registry.listInbox(b.id)![0]!.from.relation).toBe("granted")
    await asA.close()
  })

  it("tree edges stay parent / child; an allowed sibling stays sibling", async () => {
    const root = spawn("root", "w2")
    const a = spawn("a", "w", { parentSessionId: root.id })
    const b = spawn("b", "w", { parentSessionId: root.id })
    const asA = await toolsAs(registry, a.id, { messagingAllowSiblings: true })
    expect(await asA.call("message_send", { to: root.id, text: "x", urgency: "fyi" })).toMatchObject({ relation: "child" })
    expect(await asA.call("message_send", { to: b.id, text: "x", urgency: "fyi" })).toMatchObject({ relation: "sibling" })
    const asRoot = await toolsAs(registry, root.id)
    expect(await asRoot.call("message_send", { to: a.id, text: "x", urgency: "fyi" })).toMatchObject({ relation: "parent" })
    await asA.close()
    await asRoot.close()
  })

  it("a sibling admitted only by a peer group is `granted`", () => {
    const a = { id: "a", parentSessionId: "r", workspaceSlug: "ws1" }
    const b = { id: "b", parentSessionId: "r", workspaceSlug: "ws2" }
    expect(resolveMessageAcl(a, b, { peerGroups: [["ws1", "ws2"]] })).toMatchObject({
      relation: "granted",
      allowed: true,
    })
    expect(resolveMessageAcl(a, b, { allowSiblings: true, peerGroups: [["ws1", "ws2"]] }).relation).toBe("sibling")
  })

  it("resolveEffectiveRelation: a tree edge is never `granted`", () => {
    expect(
      resolveEffectiveRelation(
        { id: "p", workspaceSlug: "ws" },
        { id: "c", parentSessionId: "p", workspaceSlug: "ws" },
      ),
    ).toBe("parent")
    expect(
      resolveEffectiveRelation(
        { id: "c", parentSessionId: "p", workspaceSlug: "ws" },
        { id: "p", workspaceSlug: "ws" },
      ),
    ).toBe("child")
    expect(resolveEffectiveRelation({ id: "x", workspaceSlug: "ws" }, { id: "y", workspaceSlug: "ws" })).toBe("granted")
  })

  it("from.agentSlug is the sender's meta.agentId when bound, absent otherwise", async () => {
    const bound = spawn("bound", "w", { meta: { agentId: "reviewer" } })
    const plain = spawn("plain", "w")
    const to = spawn("to", "w")
    const asBound = await toolsAs(registry, bound.id)
    const asPlain = await toolsAs(registry, plain.id)
    await asBound.call("message_send", { to: to.id, text: "one", urgency: "fyi" })
    await asPlain.call("message_send", { to: to.id, text: "two", urgency: "fyi" })
    const inbox = registry.listInbox(to.id)!
    const fromBound = inbox.find(m => m.text === "one")!.from
    const fromPlain = inbox.find(m => m.text === "two")!.from
    expect(fromBound.agentSlug).toBe("reviewer")
    expect(fromPlain).not.toHaveProperty("agentSlug")
    await asBound.close()
    await asPlain.close()
  })

  it("messageFrom keeps `role` (deprecated) next to `agentSlug`", () => {
    const from = messageFrom({ id: "s", role: "executor", agentSlug: "reviewer", adapterSlug: "mock" }, "child")
    expect(from).toMatchObject({ sessionId: "s", role: "executor", agentSlug: "reviewer", adapter: "mock", relation: "child" })
    expect(messageFrom({ id: "s", meta: { agentId: "viaMeta" } }, "child").agentSlug).toBe("viaMeta")
    expect(messageFrom({ id: "s", meta: { agentId: "" } }, "child")).not.toHaveProperty("agentSlug")
  })
})

describe("legacy `peer` records", () => {
  it("normalizeMessageRelation maps peer to granted and rejects unknown values", () => {
    expect(normalizeMessageRelation("peer")).toBe("granted")
    expect(normalizeMessageRelation("granted")).toBe("granted")
    expect(normalizeMessageRelation("child")).toBe("child")
    expect(normalizeMessageRelation("nonsense")).toBeUndefined()
  })

  it("the ACL reads a stored peer like granted", () => {
    expect(isMessageAllowed("peer")).toBe(true)
    expect(isMessageAllowed("peer", { allowSameWorkspace: false })).toBe(false)
    expect(isMessageAllowed("peer", { allowSameWorkspace: false, peerGroup: true })).toBe(true)
  })

  const legacy = (): SessionMessage => {
    const msg = createSessionMessage({ to: "r", from: { sessionId: "s", relation: "granted" }, text: "old" })
    return { ...msg, from: { ...msg.from, relation: "peer" } }
  }

  it("a stored peer message still passes the sender filter and renders", () => {
    const msg = legacy()
    expect(matchesMessageFilter(msg, { from: ["s"] })).toBe(true)
    expect(matchesMessageFilter(msg, { from: "children" })).toBe(false)
    expect(renderSessionMessage(msg)).toContain('from="granted"')
  })

  it("an inbox holding a peer message lists it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "envelope-legacy-"))
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    try {
      const r = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: quiet("acp-r"), adapterSlug: "mock" })
      const msg = { ...legacy(), to: r.id, urgency: "fyi" as const }
      const seen: string[] = []
      bus.on("session:message", e => seen.push(e.relation))
      await registry.sendMessage(msg, { source: "peer:s", origin: "peer:s" })
      const listed = registry.listInbox(r.id)!
      expect(listed.map(m => m.id)).toEqual([msg.id])
      // The bus event speaks the new vocabulary even for a stored `peer`.
      expect(seen).toEqual(["granted"])
    } finally {
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
