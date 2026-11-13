/**
 * `reach_send` (reach/tell.ts, reach/tools.ts): a session tells the owner
 * something through the route. Fake adapters and a fake Telegram fetch only.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ReachAdapter, ReachMessage, ReachReceipt } from "@agentproto/reach"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApprovalTelegramBridge } from "../approvals/telegram-bridge.js"
import { createApprovalsEngine } from "../approvals/engine.js"
import { createTelegramReachAdapter, createReachTeller, registerReachTools, REACH_TELL_DAILY_LIMIT } from "../reach/index.js"
import { createSessionEventBus } from "../session-event-bus.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reach-send-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeAdapter(id: string, status: "delivered" | "failed" = "delivered") {
  const sent: ReachMessage[] = []
  const adapter: ReachAdapter = {
    id,
    kind: "webhook",
    capabilities: { maxChars: 1000, actions: 0, files: false, link: true, defers: false, retracts: false, identity: false },
    async send(message) {
      sent.push(message)
      const at = new Date().toISOString()
      return (status === "delivered" ? { status, adapterId: id, at } : { status, reason: "boom", adapterId: id, at }) as ReachReceipt
    },
  }
  return { adapter, sent }
}

async function connect(route: ReachAdapter[], callerSessionId?: string, shared?: ReturnType<typeof createReachTeller>) {
  const teller = shared ?? createReachTeller({ route: () => route, dir, log: () => {} })
  const server = new McpServer({ name: "t", version: "0" })
  registerReachTools(server, { teller, ...(callerSessionId ? { callerSessionId } : {}), callerLabel: () => "Scout" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "c", version: "0" })
  await client.connect(ct)
  const call = async (args: Record<string, unknown>) => {
    const res = (await client.callTool({ name: "reach_send", arguments: args })) as { content: { text: string }[] }
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  }
  return { call, teller }
}

const tells = () => readFileSync(join(dir, "tells.jsonl"), "utf8").trim().split("\n")

describe("reach_send", () => {
  it("delivers through the first adapter, keeps a receipt without the summary", async () => {
    const a = fakeAdapter("a")
    const { call } = await connect([a.adapter], "s1")
    const out = await call({ summary: "SECRET-SUMMARY", links: [{ url: "https://x.test/SECRET-LINK" }], dedupeKey: "k" })
    expect(out).toMatchObject({ status: "delivered", adapterId: "a", attempts: [{ adapterId: "a", status: "delivered" }] })
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]).toMatchObject({
      intent: "tell",
      to: "owner",
      dedupeKey: "tell:s1:k",
      source: { kind: "session", sessionId: "s1", label: "Scout" },
    })
    expect(a.sent[0]!.ask).toBeUndefined()
    const lines = tells()
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("SECRET")
    expect(JSON.parse(lines[0]!)).toMatchObject({ key: "tell:s1:k", sessionId: "s1", adapterId: "a", kind: "webhook", status: "delivered" })
  })

  it("host call has source kind host", async () => {
    const a = fakeAdapter("a")
    const { call } = await connect([a.adapter])
    await call({ summary: "hi", dedupeKey: "k" })
    expect(a.sent[0]!.source).toEqual({ kind: "host" })
    expect(a.sent[0]!.dedupeKey).toBe("tell:host:k")
  })

  it("via tries the named adapter first", async () => {
    const a = fakeAdapter("a")
    const b = fakeAdapter("b")
    const { call } = await connect([a.adapter, b.adapter], "s1")
    const out = await call({ summary: "hi", dedupeKey: "k", via: "b" })
    expect(out.adapterId).toBe("b")
    expect(a.sent).toHaveLength(0)
    expect(b.sent).toHaveLength(1)
  })

  it("dedupes per session, not across sessions", async () => {
    const a = fakeAdapter("a")
    const teller = createReachTeller({ route: () => [a.adapter], dir, log: () => {} })
    const s1 = await connect([a.adapter], "s1", teller)
    const s2 = await connect([a.adapter], "s2", teller)
    expect((await s1.call({ summary: "hi", dedupeKey: "k" })).status).toBe("delivered")
    expect((await s1.call({ summary: "hi", dedupeKey: "k" })).status).toBe("deduped")
    expect((await s2.call({ summary: "hi", dedupeKey: "k" })).status).toBe("delivered")
    expect(a.sent).toHaveLength(2)
  })

  it("dedupes from tells.jsonl after a restart", async () => {
    const a = fakeAdapter("a")
    const one = await connect([a.adapter], "s1")
    await one.call({ summary: "hi", dedupeKey: "k" })
    const two = await connect([a.adapter], "s1")
    expect((await two.call({ summary: "hi", dedupeKey: "k" })).status).toBe("deduped")
    expect(a.sent).toHaveLength(1)
  })

  it("refuses urgency now and sends nothing", async () => {
    const a = fakeAdapter("a")
    const { call } = await connect([a.adapter], "s1")
    expect(await call({ summary: "hi", dedupeKey: "k", urgency: "now" })).toMatchObject({ error: "urgency_now_refused" })
    expect(a.sent).toHaveLength(0)
  })

  it("rate limits the 21st acknowledged tell of a session", async () => {
    const a = fakeAdapter("a")
    const { call } = await connect([a.adapter], "s1")
    for (let i = 0; i < REACH_TELL_DAILY_LIMIT; i++) {
      expect((await call({ summary: "hi", dedupeKey: `k${i}` })).status).toBe("delivered")
    }
    expect(await call({ summary: "hi", dedupeKey: "over" })).toMatchObject({ error: "reach_rate_limited" })
    expect(a.sent).toHaveLength(REACH_TELL_DAILY_LIMIT)
    const other = await connect([a.adapter], "s2")
    expect((await other.call({ summary: "hi", dedupeKey: "k0" })).status).toBe("delivered")
  })

  it("rejects non-https links", async () => {
    const a = fakeAdapter("a")
    const { call } = await connect([a.adapter], "s1")
    const res = await call({ summary: "hi", dedupeKey: "k", links: [{ url: "http://x.test" }] }).catch(() => ({ error: "rejected" }))
    expect(res.error).toBeDefined()
    expect(a.sent).toHaveLength(0)
  })

  it("no route: undelivered(no-route)", async () => {
    const { call } = await connect([], "s1")
    expect(await call({ summary: "hi", dedupeKey: "k" })).toMatchObject({ status: "undelivered", reason: "no-route" })
  })
})

describe("the floor learns tell", () => {
  function floor() {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
    }) as typeof fetch
    const bus = createSessionEventBus()
    const engine = createApprovalsEngine({ homeDir: dir, sessionEvents: bus, webOrigins: [] })
    const bridge = createApprovalTelegramBridge({
      events: bus,
      engine,
      telegramCreds: { read: async () => ({ token: "T" }), write: async () => {}, exists: async () => true } as never,
      alias: "default",
      chatId: "4242",
      allowedUserIds: ["1001"],
      fetchImpl,
    })
    return { bridge, calls, engine }
  }

  it("posts the tell as escaped plain text to the cards' chat after a failure", async () => {
    const { bridge, calls, engine } = floor()
    const bad = fakeAdapter("a", "failed")
    const tg = createTelegramReachAdapter({ id: "floor", bridge, bridgeAlias: "default" })
    const { call } = await connect([bad.adapter, tg], "s1")
    const out = await call({ summary: "<b>hot</b> & done", links: [{ url: "https://x.test/p", label: "PR" }], dedupeKey: "k" })
    engine.dispose()
    expect(out).toMatchObject({ status: "delivered", adapterId: "floor" })
    expect(out.attempts).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("sendMessage")
    expect(calls[0]!.body).toMatchObject({
      chat_id: "4242",
      parse_mode: "HTML",
      text: "&lt;b&gt;hot&lt;/b&gt; &amp; done\nPR: https://x.test/p",
    })
  })

  it("a bridge without tell answers undelivered, never an approval", async () => {
    const tg = createTelegramReachAdapter({ id: "floor", bridge: { announce: async () => ({ posted: true }) } })
    const { call } = await connect([tg], "s1")
    expect(await call({ summary: "hi", dedupeKey: "k" })).toMatchObject({
      status: "undelivered",
      attempts: [{ adapterId: "floor", status: "undelivered", reason: "tell-not-supported" }],
    })
  })
})
