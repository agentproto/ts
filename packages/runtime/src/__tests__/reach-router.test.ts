/**
 * The REACH router (`reach/router.ts`): on `approval:requested` one message
 * goes down the owner's route (here `[webhook, telegram]`) until an adapter
 * acknowledges; every attempt lands in `<id>/reach.json`; nobody acknowledging
 * emits `reach:undelivered`; a restart re-announces nothing; the watchdog sends
 * a forgotten approval through the floor; `reach: false` opts out; decided and
 * expired close the webhook that acknowledged.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createApprovalTelegramBridge, type ApprovalTelegramBridge } from "../approvals/telegram-bridge.js"
import type { ApprovalReachOption, ApprovalRecord } from "../approvals/types.js"
import { createReachRoute, createReachRouter, type ReachRouter } from "../reach/index.js"
import { createSessionEventBus, type SessionEvent, type SessionEventBus } from "../session-event-bus.js"

const CHAT = "4242"
const OWNER = "1001"
const SECRET = "whsec_" + Buffer.alloc(32, 3).toString("base64")
const RECEIVER = "https://receiver.invalid/api/reach"
const creds = { read: async () => ({ token: "TOKEN" }), write: async () => {}, exists: async () => true }

interface TgCall {
  method: string
  body: Record<string, unknown>
}

function fakeTelegram(refuse?: (call: TgCall) => string | undefined) {
  const calls: TgCall[] = []
  let nextMessageId = 700
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> }
    calls.push(call)
    const refusal = refuse?.(call)
    if (refusal) return new Response(JSON.stringify({ ok: false, description: refusal }), { status: 400 })
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** Standard Webhooks verification, written independently of the signer:
 *  HMAC-SHA256 over `id.timestamp.body`, keyed by the base64 payload of the
 *  `whsec_` secret, compared in constant time. */
function verifySignature(headers: Headers, body: string, secret: string): boolean {
  const id = headers.get("webhook-id") ?? ""
  const ts = headers.get("webhook-timestamp") ?? ""
  const key = Buffer.from(secret.slice("whsec_".length), "base64")
  const expected = Buffer.from("v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64"))
  return (headers.get("webhook-signature") ?? "").split(" ").some(candidate => {
    const got = Buffer.from(candidate)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

interface HookCall {
  url: string
  body: { type: string; message?: Record<string, unknown>; dedupeKey?: string; outcome?: string }
  signed: boolean
}

type HookAnswer = Response | "hang"

function fakeReceiver(answer: (call: HookCall) => HookAnswer) {
  const calls: HookCall[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = new TextDecoder().decode(init?.body as Uint8Array)
    const call: HookCall = {
      url: String(url),
      body: JSON.parse(text) as HookCall["body"],
      signed: verifySignature(new Headers(init?.headers as Record<string, string>), text, SECRET),
    }
    calls.push(call)
    const out = answer(call)
    if (out === "hang") return new Promise<Response>(() => {})
    return out
  }) as typeof fetch
  return { fetchImpl, calls }
}

const receipt = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error("condition never became true")
}

describe("REACH router", () => {
  let home: string
  let bus: SessionEventBus
  let events: SessionEvent[]
  let engine: ApprovalsEngine
  let tg: ReturnType<typeof fakeTelegram>
  let hook: ReturnType<typeof fakeReceiver>
  let bridge: ApprovalTelegramBridge
  let router: ReachRouter | undefined
  let logs: string[]

  const webhookEntry = (over: Record<string, unknown> = {}) => ({ id: "pygmalion", kind: "webhook", url: RECEIVER, secret: SECRET, ...over })
  const floorEntry = { id: "floor", kind: "telegram" }

  function startReach(opts: { route?: unknown[]; answer?: (call: HookCall) => HookAnswer; tgRefuse?: (c: TgCall) => string | undefined } = {}) {
    tg = fakeTelegram(opts.tgRefuse)
    hook = fakeReceiver(opts.answer ?? (() => receipt({ status: "delivered" })))
    bridge = createApprovalTelegramBridge({
      events: bus,
      engine,
      telegramCreds: creds,
      alias: "default",
      chatId: CHAT,
      allowedUserIds: [OWNER],
      fetchImpl: tg.fetchImpl,
      announceOnRequested: false,
    })
    bridge.start()
    const { adapters, skipped } = createReachRoute(opts.route ?? [webhookEntry(), floorEntry], {
      telegramBridge: bridge,
      telegramAlias: "default",
      fetchImpl: hook.fetchImpl,
    })
    expect(skipped).toEqual([])
    router = createReachRouter({ events: bus, engine, route: adapters, log: line => logs.push(line) })
    router.start()
    return router
  }

  const request = (over: { channels?: ("telegram" | "ui_card")[]; reach?: ApprovalReachOption; expiresInMs?: number } = {}): ApprovalRecord =>
    engine.request(
      {
        kind: "jobkit.submit",
        title: "Submit the form for Acme",
        preview: { summary: "Submit the filled form for Backend Engineer at Acme", recipe: "legacy" },
        payload: { requestId: "req_1" },
        appId: "@agentik/job-application-kit",
        expiresAt: new Date(Date.now() + (over.expiresInMs ?? 3_600_000)).toISOString(),
        ...(over.channels ? { channels: over.channels } : {}),
        ...(over.reach !== undefined ? { reach: over.reach } : {}),
      },
      { sessionId: "sess_emploi" },
    )

  const receipts = (id: string) =>
    (JSON.parse(readFileSync(join(home, id, "reach.json"), "utf8")) as { receipts: Array<Record<string, unknown>> }).receipts

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reach-router-"))
    bus = createSessionEventBus()
    events = []
    logs = []
    bus.onAny(e => events.push(e))
    engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, telegramCards: true })
    router = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    router?.stop()
    bridge?.stop()
    engine.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  it("a receiver answering delivered gets one signed message and the bridge posts no card", async () => {
    const r = startReach()
    const record = request()
    await r.route(record.id)

    expect(hook.calls).toHaveLength(1)
    const call = hook.calls[0]!
    expect(call.url).toBe(RECEIVER)
    expect(call.signed).toBe(true)
    expect(call.body.type).toBe("message")
    expect(call.body.message).toMatchObject({
      summary: "Submit the filled form for Backend Engineer at Acme",
      intent: "ask",
      to: "owner",
      urgency: "normal",
      dedupeKey: `approval:${record.id}`,
      expiresAt: record.expiresAt,
      source: { kind: "jobkit.submit", appId: "@agentik/job-application-kit", sessionId: "sess_emploi" },
      ask: { ref: record.id, options: ["approve", "deny"] },
    })
    expect(call.body.message).not.toHaveProperty("recipe")
    await new Promise(r => setTimeout(r, 20))
    expect(tg.calls.filter(c => c.method === "sendMessage")).toHaveLength(0)

    const rs = receipts(record.id)
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({ dedupeKey: `approval:${record.id}`, adapterId: "pygmalion", kind: "webhook", status: "delivered", trigger: "route" })
    expect(JSON.stringify(rs)).not.toContain(SECRET)
    expect(JSON.stringify(rs)).not.toContain(RECEIVER)
    expect(events.some(e => e.type === "reach:undelivered")).toBe(false)
  })

  it.each([
    ["times out", "timeout", (() => "hang") as () => HookAnswer],
    ["answers 500", "http-500", () => new Response("boom", { status: 500 })],
    ["answers a bare 200", "malformed-receipt", () => new Response(null, { status: 200 })],
    ["answers a 200 that is not a receipt", "malformed-receipt", () => receipt({ ok: true })],
  ])("the receiver %s: the bridge posts and reach.json has failed then delivered", async (_name, reason, answer) => {
    const r = startReach({ route: [webhookEntry({ timeoutMs: 50 }), floorEntry], answer })
    const record = request()
    await r.route(record.id)

    const sends = tg.calls.filter(c => c.method === "sendMessage")
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body.chat_id).toBe(CHAT)
    expect(receipts(record.id).map(e => [e.adapterId, e.status, e.reason])).toEqual([
      ["pygmalion", "failed", reason],
      ["floor", "delivered", undefined],
    ])
  })

  it("a deferred receipt past expiresAt falls to the bridge", async () => {
    const r = startReach({
      answer: call =>
        receipt({ status: "deferred", until: new Date(Date.parse(String(call.body.message!.expiresAt)) + 3_600_000).toISOString() }),
    })
    const record = request({ expiresInMs: 10 * 60_000 })
    await r.route(record.id)

    expect(tg.calls.filter(c => c.method === "sendMessage")).toHaveLength(1)
    expect(receipts(record.id).map(e => [e.status, e.reason])).toEqual([
      ["undelivered", "deferred-past-expiry"],
      ["delivered", undefined],
    ])
  })

  it("a deferred receipt before expiresAt acknowledges: no card", async () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    const r = startReach({ answer: () => receipt({ status: "deferred", until }) })
    const record = request()
    await r.route(record.id)
    expect(tg.calls).toHaveLength(0)
    expect(receipts(record.id)).toEqual([expect.objectContaining({ status: "deferred", until })])
  })

  it("both fail (Telegram refuses the card): reach:undelivered is emitted and logged", async () => {
    const r = startReach({
      answer: () => new Response("", { status: 503 }),
      tgRefuse: c => (c.method === "sendMessage" ? "Bad Request: chat not found" : undefined),
    })
    const record = request()
    await r.route(record.id)

    const ev = events.find(e => e.type === "reach:undelivered")
    expect(ev).toMatchObject({
      approvalId: record.id,
      dedupeKey: `approval:${record.id}`,
      trigger: "route",
      attempts: [
        { adapterId: "pygmalion", status: "failed", reason: "http-503" },
        { adapterId: "floor", status: "failed", reason: "telegram-send-failed" },
      ],
    })
    expect(logs).toContain(`reach: undelivered ${record.id}`)
  })

  it("both fail (the record does not list the telegram channel): reach:undelivered is emitted", async () => {
    const r = startReach({ answer: () => new Response("", { status: 500 }) })
    const record = request({ channels: ["ui_card"] })
    await r.route(record.id)

    expect(tg.calls).toHaveLength(0)
    expect(receipts(record.id).map(e => [e.adapterId, e.status, e.reason])).toEqual([
      ["pygmalion", "failed", "http-500"],
      ["floor", "undelivered", "channel-not-listed"],
    ])
    expect(events.filter(e => e.type === "reach:undelivered")).toHaveLength(1)
    expect(logs).toContain(`reach: undelivered ${record.id}`)
  })

  it("a second approval:requested for the same id (simulated restart) sends nothing", async () => {
    const r = startReach()
    const record = request()
    await r.route(record.id)
    expect(hook.calls).toHaveLength(1)
    r.stop()
    bridge.stop()
    engine.dispose()

    // A new daemon run on the same approvals dir, and the event replayed.
    engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, telegramCards: true })
    const r2 = startReach()
    bus.emit({ type: "approval:requested", approvalId: record.id, kind: record.kind, ts: new Date().toISOString() })
    await r2.route(record.id)

    expect(hook.calls).toHaveLength(0)
    expect(tg.calls).toHaveLength(0)
    expect(receipts(record.id)).toHaveLength(1)
  })

  it("watchdog: an approval with no receipt after 60 s is logged MISSING and goes through the floor", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    // Requested before the router runs, so no route pass ever saw it.
    const record = request()
    startReach()

    vi.advanceTimersByTime(30_000)
    await new Promise(r => setTimeout(r, 20))
    expect(logs).toEqual([])
    vi.advanceTimersByTime(61_000)
    await until(() => tg.calls.some(c => c.method === "sendMessage"))

    expect(logs).toEqual([`reach: MISSING ${record.id}`])
    expect(hook.calls).toHaveLength(0)
    expect(receipts(record.id)).toEqual([expect.objectContaining({ adapterId: "floor", status: "delivered", trigger: "watchdog" })])

    // Once per approval: later ticks find the acknowledging receipt.
    vi.advanceTimersByTime(120_000)
    await new Promise(r => setTimeout(r, 20))
    expect(tg.calls.filter(c => c.method === "sendMessage")).toHaveLength(1)
  })

  it("watchdog with no telegram entry in the route: MISSING, then reach:undelivered", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const record = request()
    startReach({ route: [webhookEntry()] })
    vi.advanceTimersByTime(91_000)
    await until(() => events.some(e => e.type === "reach:undelivered"))
    expect(logs).toEqual([`reach: MISSING ${record.id}`, `reach: undelivered ${record.id}`])
    expect(events.find(e => e.type === "reach:undelivered")).toMatchObject({ trigger: "watchdog", attempts: [] })
  })

  it("reach: false on the request: nothing is sent, nothing is logged missing, no reach.json", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const r = startReach()
    const record = request({ reach: false })
    expect(engine.get(record.id)!.reach).toBe(false)
    await r.route(record.id)
    vi.advanceTimersByTime(200_000)
    await new Promise(r => setTimeout(r, 20))

    expect(hook.calls).toHaveLength(0)
    expect(tg.calls).toHaveLength(0)
    expect(logs).toEqual([])
    expect(existsSync(join(home, record.id, "reach.json"))).toBe(false)
  })

  it("carries the request's urgency on the message", async () => {
    const r = startReach()
    const record = request({ reach: { urgency: "digest" } })
    await r.route(record.id)
    expect(hook.calls[0]!.body.message).toMatchObject({ urgency: "digest" })
  })

  it("decided calls close on the acknowledging webhook, once", async () => {
    const r = startReach()
    const record = request()
    await r.route(record.id)
    await engine.decideTelegram(record.id, "approve", { ipAddress: "t", userAgent: "t" })
    await until(() => hook.calls.some(c => c.body.type === "close"))

    const closes = hook.calls.filter(c => c.body.type === "close")
    expect(closes).toHaveLength(1)
    expect(closes[0]!.signed).toBe(true)
    expect(closes[0]!.body).toEqual({ type: "close", dedupeKey: `approval:${record.id}`, outcome: "approved" })
  })

  it("expired calls close on the acknowledging webhook", async () => {
    const r = startReach()
    const record = request({ expiresInMs: 80 })
    await r.route(record.id)
    await new Promise(r => setTimeout(r, 120))
    expect(engine.get(record.id)!.status).toBe("expired")
    await until(() => hook.calls.some(c => c.body.type === "close"))
    expect(hook.calls.find(c => c.body.type === "close")!.body).toEqual({
      type: "close",
      dedupeKey: `approval:${record.id}`,
      outcome: "expired",
    })
  })

  it("does not call close on the webhook when the floor acknowledged", async () => {
    const r = startReach({ answer: () => new Response("", { status: 500 }) })
    const record = request()
    await r.route(record.id)
    await engine.decideTelegram(record.id, "deny", { ipAddress: "t", userAgent: "t" })
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    expect(hook.calls.filter(c => c.body.type === "close")).toHaveLength(0)
  })

  it("skips an unusable route entry by id and reason, never echoing its URL or secret", () => {
    const { adapters, skipped } = createReachRoute([
      { id: "a", kind: "webhook", url: RECEIVER, secret: "not-a-secret" },
      { id: "b", kind: "webhook", url: "ftp://x", secret: SECRET },
      { id: "c", kind: "pigeon" },
      { kind: "telegram" },
      { id: "floor", kind: "telegram" },
      { id: "floor", kind: "telegram" },
    ])
    expect(adapters.map(a => a.id)).toEqual(["floor"])
    expect(skipped).toEqual([
      { index: 0, id: "a", reason: "invalid-secret" },
      { index: 1, id: "b", reason: "invalid-url" },
      { index: 2, id: "c", reason: "unknown-kind" },
      { index: 3, reason: "missing-id" },
      { index: 5, id: "floor", reason: "duplicate-id" },
    ])
  })
})

describe("no reach config: today's behaviour", () => {
  it("index.ts starts no router and leaves the bridge announcing unless reach.routes.owner has a usable entry", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8")
    expect(source).toContain("const reachOn = reachRouteCheck.adapters.length > 0")
    expect(source).toContain("...(reachOn ? { announceOnRequested: false } : {}),")
    expect(source).toMatch(/const reachRouter = reachOn\s+\? createReachRouter\(/)
  })
})

describe("REACH words", () => {
  it("the new folders use no notice, notify or sink identifier", () => {
    const dirs = [
      fileURLToPath(new URL("../reach", import.meta.url)),
      fileURLToPath(new URL("../../../reach/src", import.meta.url)),
    ]
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\b(notice|notif|sink)/i.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(true)
      walk(dir)
    }
    expect(offenders).toEqual([])
  })
})
