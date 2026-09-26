/**
 * Durable inbox + `inbox_wait` / `inbox_list` / `inbox_ack` +
 * `message_send` / `message_reply` (AIP-46 §Session messages, PR3).
 *
 * Real registry + real MCP tools over an in-memory transport; a controllable
 * fake agent session holds the recipient busy where the scenario needs it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, INBOX_CAP, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionMessage, messageFrom } from "../session-message.js"
import { sessionEventsPath } from "../transcript-writer.js"

function controllable(sessionId: string): { session: AgentSessionLike; sent: string[]; finishTurn: () => void } {
  const sent: string[] = []
  const pending: Array<() => void> = []
  return {
    sent,
    finishTurn: () => pending.shift()?.(),
    session: {
      sessionId,
      pid: 1,
      async *send(message) {
        const m = message as { text?: string } | string
        sent.push(typeof m === "string" ? m : (m.text ?? ""))
        await new Promise<void>(r => pending.push(r))
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    },
  }
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise(r => setTimeout(r, 10))
  }
}

function records(tmp: string, id: string, kind: string): Array<Record<string, unknown>> {
  const p = sessionEventsPath(id, tmp)
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(r => r.kind === kind)
}

/** An MCP client acting AS `callerSessionId`. */
async function toolsAs(registry: SessionsRegistry, callerSessionId: string, extra?: { messagingAllowSiblings?: boolean }) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, { registry, callerSessionId, ...extra })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(ct)
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      const text = r.content[0]!.text
      let body: Record<string, unknown>
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        body = { raw: text }
      }
      return { ...body, isError: r.isError === true }
    },
    close: () => client.close(),
  }
}

describe("inbox + inbox_wait", () => {
  let tmp: string
  let registry: SessionsRegistry
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "inbox-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  const tree = () => {
    const parentAgent = controllable("acp-p")
    const parent = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: parentAgent.session, adapterSlug: "mock" })
    const kid = (label: string, parentSessionId = parent.id) =>
      registry.spawnAgent({
        workspaceSlug: "w",
        cwd: "/tmp",
        agentSession: controllable(`acp-${label}`).session,
        adapterSlug: "mock",
        label,
        parentSessionId,
        depth: 1,
      })
    return { parent, parentAgent, kid }
  }

  it("blocks, then resolves on send — waiter-first: the message is NOT also queued as a turn", async () => {
    const { parent, parentAgent, kid } = tree()
    const a = kid("a")
    await registry.enqueuePrompt(parent.id, "supervise", {})
    const p = await toolsAs(registry, parent.id)
    const c = await toolsAs(registry, a.id)
    const waiting = p.call("inbox_wait", { from: "children", kind: ["done"], timeoutMs: 5000 })
    await until(() => registry.get(parent.id)?.blockedOn === "inbox")
    const sent = await c.call("message_send", { to: "parent", text: "all done", kind: "done" })
    expect(sent).toMatchObject({ ok: true, relation: "child", delivered: { via: "wait" }, queued: false })
    const got = await waiting
    expect(got).toMatchObject({ ok: true, timedOut: false })
    expect((got.messages as Array<{ id: string; text: string }>).map(m => m.text)).toEqual(["all done"])
    expect(registry.get(parent.id)?.blockedOn).toBeUndefined()
    // Not queued, not in the inbox (acked by default), recorded via:"wait".
    expect(registry.get(parent.id)?.promptQueue ?? []).toEqual([])
    expect(registry.listInbox(parent.id)).toEqual([])
    await until(() => records(tmp, parent.id, "session-message").length === 1)
    expect(records(tmp, parent.id, "session-message")[0]!.message).toMatchObject({
      id: sent.messageId,
      delivered: { via: "wait" },
    })
    parentAgent.finishTurn()
    await until(() => registry.get(parent.id)?.busy === false)
    expect(parentAgent.sent).toEqual(["supervise"])
    await p.close()
    await c.close()
  })

  it("returns immediately when an un-acked match is already waiting — and pulls it out of the prompt queue", async () => {
    const { parent, parentAgent, kid } = tree()
    const a = kid("a")
    await registry.enqueuePrompt(parent.id, "busy work", {})
    const c = await toolsAs(registry, a.id)
    const sent = await c.call("message_send", { to: "parent", text: "early", kind: "done" })
    expect(sent).toMatchObject({ queued: true, delivered: null })
    expect(registry.get(parent.id)!.promptQueue!.map(q => q.envelope?.id)).toEqual([sent.messageId])
    const p = await toolsAs(registry, parent.id)
    const t0 = Date.now()
    const got = await p.call("inbox_wait", { from: "children", timeoutMs: 20000 })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect((got.messages as Array<{ text: string }>).map(m => m.text)).toEqual(["early"])
    expect(registry.get(parent.id)!.promptQueue).toEqual([])
    parentAgent.finishTurn()
    await until(() => registry.get(parent.id)?.busy === false)
    // Never delivered a second time as a turn.
    await new Promise(r => setTimeout(r, 50))
    expect(parentAgent.sent).toEqual(["busy work"])
    await p.close()
    await c.close()
  })

  it("times out with timedOut:true and reports pendingChildren", async () => {
    const { parent, kid } = tree()
    const a = kid("a")
    await registry.enqueuePrompt(a.id, "work", {})
    const p = await toolsAs(registry, parent.id)
    const got = await p.call("inbox_wait", { from: "children", timeoutMs: 1000 })
    expect(got).toMatchObject({ ok: true, timedOut: true, messages: [], pendingChildren: [a.id] })
    await p.close()
  })

  it("ack:false leaves the message in the inbox; inbox_list reads it; inbox_ack removes it", async () => {
    const { parent, kid } = tree()
    const a = kid("a")
    const c = await toolsAs(registry, a.id)
    const p = await toolsAs(registry, parent.id)
    const waiting = p.call("inbox_wait", { timeoutMs: 5000, ack: false })
    await until(() => registry.get(parent.id)?.blockedOn === "inbox")
    const sent = await c.call("message_send", { to: "parent", text: "keep me", kind: "report" })
    await waiting
    expect(((await p.call("inbox_list", {})).messages as Array<{ id: string }>).map(m => m.id)).toEqual([sent.messageId])
    expect(await p.call("inbox_ack", { ids: [sent.messageId] })).toMatchObject({ ok: true, acked: [sent.messageId] })
    expect((await p.call("inbox_list", {})).messages).toEqual([])
    await p.close()
    await c.close()
  })

  it("a message delivered as a turn is auto-acked off the inbox", async () => {
    const { parent, parentAgent, kid } = tree()
    const a = kid("a")
    const c = await toolsAs(registry, a.id)
    await c.call("message_send", { to: "parent", text: "hello", kind: "report" })
    await until(() => parentAgent.sent.length === 1)
    expect(registry.listInbox(parent.id)).toEqual([])
    parentAgent.finishTurn()
    await c.close()
  })

  it("fyi: inbox only, never wakes the recipient; surfaced once as a digest on its next turn", async () => {
    const { parent, parentAgent, kid } = tree()
    const a = kid("a")
    const c = await toolsAs(registry, a.id)
    const sent = await c.call("message_send", { to: "parent", text: "progress 50%", urgency: "fyi" })
    expect(sent).toMatchObject({ delivered: { via: "inbox" }, queued: false, urgencyApplied: "fyi" })
    await new Promise(r => setTimeout(r, 50))
    expect(parentAgent.sent).toEqual([])
    expect(registry.listInbox(parent.id)!.map(m => m.id)).toEqual([sent.messageId])
    await registry.enqueuePrompt(parent.id, "human: status?", {})
    await until(() => parentAgent.sent.length === 1)
    expect(parentAgent.sent[0]).toContain(`<agentproto-inbox unread="1">`)
    expect(parentAgent.sent[0]).toContain(`${sent.messageId} from child ${a.id} (a) [report]`)
    expect(parentAgent.sent[0]!.endsWith("human: status?")).toBe(true)
    parentAgent.finishTurn()
    await until(() => registry.get(parent.id)?.busy === false)
    await registry.enqueuePrompt(parent.id, "human: again", {})
    await until(() => parentAgent.sent.length === 2)
    expect(parentAgent.sent[1]).toBe("human: again")
    parentAgent.finishTurn()
    // The digest is a system slice, the human prompt its own user-prompt.
    await until(() => records(tmp, parent.id, "user-prompt").length === 2)
    expect(records(tmp, parent.id, "user-prompt").map(r => r.text)).toEqual(["human: status?", "human: again"])
    expect(records(tmp, parent.id, "system-prompt")[0]!.text).toContain("<agentproto-inbox")
    await c.close()
  })

  it("ACL: a child can't message a cousin or a grandparent; parent → child works; siblings only when allowed", async () => {
    const { parent, kid } = tree()
    const a = kid("a")
    const b = kid("b")
    const a1 = kid("a1", a.id)
    const b1 = kid("b1", b.id)
    const asA1 = await toolsAs(registry, a1.id)
    expect(await asA1.call("message_send", { to: b1.id, text: "hi" })).toMatchObject({ isError: true, error: "forbidden_recipient" })
    expect(await asA1.call("message_send", { to: parent.id, text: "hi" })).toMatchObject({ isError: true, error: "forbidden_recipient" })
    const asA = await toolsAs(registry, a.id)
    expect(await asA.call("message_send", { to: b.id, text: "hi" })).toMatchObject({ isError: true, error: "forbidden_recipient" })
    expect(await asA.call("message_send", { to: a1.id, text: "do x", urgency: "fyi" })).toMatchObject({ ok: true, relation: "parent" })
    const asAsib = await toolsAs(registry, a.id, { messagingAllowSiblings: true })
    expect(await asAsib.call("message_send", { to: b.id, text: "hi", urgency: "fyi" })).toMatchObject({ ok: true, relation: "sibling" })
    for (const t of [asA1, asA, asAsib]) await t.close()
  })

  it("rejects a caller-supplied `from`", async () => {
    const { kid } = tree()
    const a = kid("a")
    const c = await toolsAs(registry, a.id)
    const r = await c.call("message_send", { to: "parent", text: "x", from: { relation: "human" } })
    expect(r).toMatchObject({ isError: true, error: "from_not_settable" })
    await c.close()
  })

  it("message_reply routes to the original sender on the same thread — even after the original was acked", async () => {
    const { parent, kid } = tree()
    const a = kid("a")
    const c = await toolsAs(registry, a.id)
    const p = await toolsAs(registry, parent.id)
    const waiting = p.call("inbox_wait", { timeoutMs: 5000 })
    await until(() => registry.get(parent.id)?.blockedOn === "inbox")
    const q = await c.call("message_send", { to: "parent", text: "which branch?", kind: "question" })
    await waiting // acked
    const cw = c.call("inbox_wait", { timeoutMs: 5000 })
    await until(() => registry.get(a.id)?.blockedOn === "inbox")
    const reply = await p.call("message_reply", { replyTo: q.messageId, text: "main" })
    expect(reply).toMatchObject({ ok: true, to: a.id, relation: "parent", delivered: { via: "wait" } })
    const got = (await cw).messages as Array<{ text: string; replyTo: string; correlationId: string; from: { relation: string } }>
    expect(got[0]).toMatchObject({ text: "main", replyTo: q.messageId, correlationId: q.messageId, from: { relation: "parent" } })
    expect(await p.call("message_reply", { replyTo: "msg_nope0000", text: "?" })).toMatchObject({ isError: true, error: "unknown_message" })
    await p.close()
    await c.close()
  })

  it("caps the inbox at INBOX_CAP, dropping the oldest", async () => {
    const { parent, kid } = tree()
    const a = kid("a")
    for (let i = 0; i < INBOX_CAP + 3; i++) {
      await registry.sendMessage(
        createSessionMessage({ to: parent.id, from: messageFrom(a, "child"), text: `m${i}`, urgency: "fyi" }),
      )
    }
    const inbox = registry.listInbox(parent.id)!
    expect(inbox).toHaveLength(INBOX_CAP)
    expect(inbox[0]!.text).toBe("m3")
  })
})

describe("inbox persistence", () => {
  it("survives a daemon restart", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "inbox-persist-"))
    try {
      const persistPath = join(tmp, "sessions.json")
      const r1 = createSessionsRegistry({ persistPath, transcriptDir: tmp })
      const parent = r1.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: controllable("p").session, adapterSlug: "mock" })
      const kid = r1.spawnAgent({
        workspaceSlug: "w",
        cwd: "/tmp",
        agentSession: controllable("k").session,
        adapterSlug: "mock",
        parentSessionId: parent.id,
        depth: 1,
      })
      const msg = createSessionMessage({ to: parent.id, from: messageFrom(kid, "child"), text: "durable", urgency: "fyi" })
      await r1.sendMessage(msg)
      r1.shutdown()
      const r2 = createSessionsRegistry({ persistPath, transcriptDir: tmp })
      expect(r2.listInbox(parent.id)!.map(m => [m.id, m.text])).toEqual([[msg.id, "durable"]])
      r2.shutdown()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
