/**
 * The `agentpush` sentinel provider (AIP-60 step 10): subscription lifecycle
 * over a mocked agentpush API, durable seq cursor across a restart, signature
 * v2 on the push path, credential sources, auto-selection, auto-link, and the
 * generalized sentinel inbound route.
 */

import { createHmac } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSetupLedger } from "@agentproto/provider-kit"
import { afterEach, describe, expect, it } from "vitest"

import { createSentinelAutoLinker } from "../sentinel-autolink.js"
import { handleSentinelInbound } from "../sentinel-inbound.js"
import { autoSelectProviderSlug } from "../sentinel-provider-select.js"
import { makeSentinelCredsStore, makeSentinelLister, type SentinelAdapterInfo } from "../sentinel-adapters.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createSentinelStore, mintSentinelId, type SentinelStore } from "../sentinel-store.js"
import {
  AGENTPUSH_DEFAULT_BASE_URL,
  agentpushSentinelProvider,
  computeSignatureV2,
  verifySignatureV2,
  type AgentpushProviderOptions,
} from "../sentinel-providers/agentpush.js"
import { webhookSentinelProvider } from "../sentinel-providers/webhook.js"
import { createWebhookHookStore } from "../sentinel-providers/webhook-hooks.js"
import {
  deliveryPreferenceFor,
  singleMatch,
  type SentinelEvent,
  type SentinelHandle,
  type SentinelProviderHandle,
  type SentinelSpec,
} from "../sentinel-providers/types.js"
import type { SessionMessage } from "../session-message.js"
import type { SendMessageResult } from "../sessions.js"

// ── Fake agentpush server (behind an injected fetch) ──────────────────

interface RecordedCall {
  method: string
  path: string
  query: Record<string, string>
  body: Record<string, unknown> | undefined
  auth: string | null
}

interface FakeRow {
  seq: number
  envelope: Record<string, unknown>
  acked: boolean
}

function envelope(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id,
    source: "agentpush://github",
    type: "github.pull_request.opened",
    subject: "github:o/r#12",
    time: "2026-09-29T00:00:00.000Z",
    datacontenttype: "application/json",
    data: {},
    summary: `event ${id}`,
    subjects: ["github:o/r#12"],
    terminal: false,
    ...over,
  }
}

function fakeAgentpush() {
  const calls: RecordedCall[] = []
  const subs = new Map<string, { view: Record<string, unknown>; rows: FakeRow[] }>()
  let counter = 0
  const state = { failAck: false, failAll: false as false | number }

  const json = (status: number, body: unknown): Response =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status })

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers as Record<string, string> | undefined)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const query = Object.fromEntries(url.searchParams.entries())
    calls.push({ method, path: url.pathname, query, body, auth: headers.get("authorization") })
    if (state.failAll) return json(state.failAll, { error: "boom" })

    if (method === "POST" && url.pathname === "/subscriptions") {
      const id = `sub_${++counter}`
      const view = { id, status: "active", callback_url: body?.callback_url ?? null }
      subs.set(id, { view, rows: [] })
      return json(201, { subscription: view })
    }
    const m = /^\/subscriptions\/([^/]+)(\/events|\/ack)?$/.exec(url.pathname)
    const sub = m ? subs.get(m[1]!) : undefined
    if (!m || !sub) return json(404, { error: "subscription_not_found" })
    if (!m[2] && method === "GET") return json(200, { subscription: sub.view })
    if (!m[2] && method === "DELETE") {
      subs.delete(m[1]!)
      return json(204, undefined)
    }
    if (!m[2] && method === "PATCH") {
      sub.view.callback_url = body?.callback_url
      return json(200, { subscription: sub.view })
    }
    if (m[2] === "/events" && method === "GET") {
      const after = Number(query.after ?? "0")
      const limit = Number(query.limit ?? "100")
      const items = sub.rows
        .filter(r => r.seq > after && !r.acked)
        .slice(0, limit)
        .map(r => ({ delivery_id: `dlv_${r.seq}`, seq: r.seq, status: "delivered", envelope: r.envelope }))
      return json(200, { items, cursor: String(items.at(-1)?.seq ?? after) })
    }
    if (m[2] === "/ack" && method === "POST") {
      if (state.failAck) return json(503, { error: "unavailable" })
      const upTo = Number(body?.upToSeq)
      let acked = 0
      for (const r of sub.rows) if (r.seq <= upTo && !r.acked) (r.acked = true), acked++
      return json(200, { acked })
    }
    return json(405, { error: "nope" })
  }) as typeof fetch

  return {
    fetch: fetchFn,
    calls,
    subs,
    state,
    push(subId: string, ...envelopes: Record<string, unknown>[]): void {
      const sub = subs.get(subId)!
      for (const env of envelopes) sub.rows.push({ seq: sub.rows.length + 1, envelope: env, acked: false })
    },
    callsTo(method: string, pathRe: RegExp): RecordedCall[] {
      return calls.filter(c => c.method === method && pathRe.test(c.path))
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

const SPEC: SentinelSpec = {
  match: singleMatch("github:o/r#12", ["github.pull_request.*"]),
  until: { kind: "subject_terminal" },
  target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
  provider: "agentpush",
}

const POLL = { mode: "poll" as const, intervalMs: 15_000 }
const NO_ALIAS = async (): Promise<string | undefined> => undefined

function mkProvider(server: ReturnType<typeof fakeAgentpush>, over: Partial<AgentpushProviderOptions> = {}) {
  return agentpushSentinelProvider({
    creds: { apiKey: "ak_secret" },
    fetch: server.fetch,
    importedBearer: NO_ALIAS,
    ...over,
  })
}

function stubRegistry() {
  const texts: string[] = []
  const registry: SentinelRuntimeRegistry = {
    async sendMessage(msg: SessionMessage): Promise<SendMessageResult> {
      texts.push(msg.text)
      return { messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }
    },
  }
  return { texts, registry }
}

function mkRuntime(store: SentinelStore, resolve: () => SentinelProviderHandle) {
  const { texts, registry } = stubRegistry()
  const runtime = createSentinelRuntime({
    store,
    registry,
    resolveProvider: async slug => (slug === "agentpush" ? resolve() : null),
    isSessionAlive: () => true,
    restartSession: async id => id,
    log: () => {},
    parkedPath: join(tmpdir(), `ap-parked-${process.pid}.jsonl`),
  })
  return { runtime, texts }
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "agentpush-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── Lifecycle ──────────────────────────────────────────────────────────

describe("agentpush provider — lifecycle over HTTP", () => {
  it("create → POST /subscriptions with the mapped body, Bearer key, sentinel consumerRef", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, POLL, { sentinelId: "sen_ABC" })

    const [call] = server.callsTo("POST", /^\/subscriptions$/)
    expect(call!.auth).toBe("Bearer ak_secret")
    expect(call!.body).toMatchObject({
      source: "github",
      subject: "github:o/r#12",
      types: ["github.pull_request.*"],
      mode: "poll",
      consumer_ref: "agentproto:sentinel:sen_ABC",
      until: { kind: "subject_terminal" },
    })
    expect(call!.body).not.toHaveProperty("callback_url")
    expect(handle).toMatchObject({
      provider: "agentpush",
      remoteId: "sub_1",
      cursor: "0",
      state: { mode: "poll", consumerRef: "agentproto:sentinel:sen_ABC" },
    })
    // The API key never lands in the handle that is persisted / returned.
    expect(JSON.stringify(handle)).not.toContain("ak_secret")
  })

  it("uses the default base URL and honours a creds/opts override", async () => {
    const seen: string[] = []
    const spy = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ subscription: { id: "s" } }), { status: 201 })
    }) as typeof fetch
    await agentpushSentinelProvider({ creds: { apiKey: "k" }, fetch: spy, importedBearer: NO_ALIAS }).create(SPEC, POLL)
    await agentpushSentinelProvider({ creds: { apiKey: "k", baseUrl: "https://ap.internal/" }, fetch: spy, importedBearer: NO_ALIAS }).create(SPEC, POLL)
    await agentpushSentinelProvider({ creds: { apiKey: "k", baseUrl: "https://ignored" }, baseUrl: "https://opt.example", fetch: spy, importedBearer: NO_ALIAS }).create(SPEC, POLL)
    expect(seen).toEqual([`${AGENTPUSH_DEFAULT_BASE_URL}/subscriptions`, "https://ap.internal/subscriptions", "https://opt.example/subscriptions"])
  })

  it("`*` types and missing clause types map sensibly; a non-github subject defaults to all types", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    await provider.create({ ...SPEC, match: singleMatch("telegram:bot-1/chat-9") }, POLL)
    await provider.create({ ...SPEC, match: singleMatch("github:o/r#1") }, POLL)
    const [tg, gh] = server.callsTo("POST", /^\/subscriptions$/)
    expect(tg!.body).toMatchObject({ source: "telegram", types: null })
    expect((gh!.body!.types as string[]).length).toBeGreaterThan(0)
  })

  it("refuses a spec spanning several subjects (one subject per sentinel)", async () => {
    const provider = mkProvider(fakeAgentpush())
    const spec: SentinelSpec = {
      ...SPEC,
      match: [...singleMatch("github:o/r#1"), ...singleMatch("github:o/r#2")],
    }
    await expect(provider.create(spec, POLL)).rejects.toThrow(/one subject/)
  })

  it("create fails with an actionable error when no key is available, without calling out", async () => {
    const server = fakeAgentpush()
    const provider = agentpushSentinelProvider({ creds: null, fetch: server.fetch, importedBearer: NO_ALIAS })
    await expect(provider.create(SPEC, POLL)).rejects.toThrow(/setup_sentinel_provider/)
    expect(server.calls).toHaveLength(0)
  })

  it("surfaces the server's error text on an HTTP failure (without the key)", async () => {
    const server = fakeAgentpush()
    server.state.failAll = 401
    const err = await mkProvider(server).create(SPEC, POLL).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/HTTP 401: boom/)
    expect((err as Error).message).not.toContain("ak_secret")
  })

  it("poll → GET events?after=<cursor>; ack → POST {upToSeq}; empty tick issues no ack", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, POLL, { sentinelId: "sen_1" })
    server.push("sub_1", envelope("e1"), envelope("e2", { type: "github.pull_request.closed" }))

    const first = await provider.poll!(handle, 50)
    expect(first.events.map(e => e.id)).toEqual(["e1", "e2"])
    expect(first.events.map(e => e.seq)).toEqual([1, 2])
    expect(first.cursor).toBe("2")
    expect(server.callsTo("GET", /events$/)[0]!.query).toMatchObject({ after: "0", limit: "50" })

    await provider.ack!(handle, first.cursor)
    expect(server.callsTo("POST", /ack$/)).toHaveLength(1)
    expect(server.callsTo("POST", /ack$/)[0]!.body).toEqual({ upToSeq: 2 })

    const caughtUp: SentinelHandle = { ...handle, cursor: "2" }
    const second = await provider.poll!(caughtUp, 50)
    expect(second).toEqual({ events: [], cursor: "2" })
    await provider.ack!(caughtUp, second.cursor)
    expect(server.callsTo("POST", /ack$/)).toHaveLength(1)
  })

  it("the envelope maps to the runtime event unchanged; malformed rows are skipped, cursor still advances", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, POLL)
    server.push("sub_1", envelope("good", { terminal: true, consumerref: "agentproto:sentinel:x" }), { nonsense: true })
    const { events, cursor } = await provider.poll!(handle, 10)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      specversion: "1.0",
      id: "good",
      type: "github.pull_request.opened",
      subject: "github:o/r#12",
      terminal: true,
      consumerref: "agentproto:sentinel:x",
      seq: 1,
    })
    expect(cursor).toBe("2")
  })

  it("cancel → DELETE, idempotent on 404; status reflects the subscription state", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, POLL)
    expect(await provider.status!(handle)).toEqual({ ok: true })
    server.subs.get("sub_1")!.view.status = "paused"
    expect(await provider.status!(handle)).toMatchObject({ ok: false, detail: expect.stringMatching(/paused/) })

    await provider.cancel(handle)
    expect(server.callsTo("DELETE", /^\/subscriptions\/sub_1$/)).toHaveLength(1)
    await expect(provider.cancel(handle)).resolves.toBeUndefined()
    expect(await provider.status!(handle)).toMatchObject({ ok: false, detail: expect.stringMatching(/deleted/) })
  })

  it("attach re-verifies the subscription: 404 throws (sentinel → error), other failures are tolerated", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, POLL)
    await expect(provider.attach(handle, POLL)).resolves.toMatchObject({ remoteId: "sub_1", cursor: "0" })

    server.state.failAll = 503
    await expect(provider.attach(handle, POLL)).resolves.toMatchObject({ remoteId: "sub_1" })

    server.state.failAll = false
    server.subs.clear()
    await expect(provider.attach(handle, POLL)).rejects.toThrow(/no longer exists/)
  })
})

// ── Push mode ──────────────────────────────────────────────────────────

describe("agentpush provider — push mode", () => {
  const pub = { url: "https://hooks.example.com", stable: true, source: "env" as const }

  it("only prefers push when opted in AND a public https origin exists", () => {
    const server = fakeAgentpush()
    const optedIn = { apiKey: "k", delivery: "push" }
    expect(mkProvider(server, { creds: optedIn, publicUrl: () => pub }).preferredDelivery!(1000)).toEqual({
      mode: "push",
      callbackUrl: "https://hooks.example.com",
    })
    expect(mkProvider(server, { creds: optedIn, publicUrl: () => undefined }).preferredDelivery!(1000)).toEqual({ mode: "poll", intervalMs: 1000 })
    expect(mkProvider(server, { creds: optedIn, publicUrl: () => ({ ...pub, url: "http://plain.example.com" }) }).preferredDelivery!(1000).mode).toBe("poll")
    expect(mkProvider(server, { publicUrl: () => pub }).preferredDelivery!(1000).mode).toBe("poll")
    expect(deliveryPreferenceFor(mkProvider(server, { creds: optedIn, publicUrl: () => pub }), 1000).mode).toBe("push")
  })

  it("create in push mode sends callback_url + a fresh secret and keeps both in the handle only", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, { mode: "push", callbackUrl: pub.url }, { sentinelId: "sen_P" })
    const [call] = server.callsTo("POST", /^\/subscriptions$/)
    const hookKey = handle.state!.hookKey as string
    const secret = handle.state!.callbackSecret as string
    expect(call!.body).toMatchObject({
      mode: "push",
      callback_url: `https://hooks.example.com/inbound/sentinel-${hookKey}`,
      callback_secret: secret,
    })
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(handle.state!.mode).toBe("push")
  })

  it("push without a callback origin falls back to a poll subscription", async () => {
    const server = fakeAgentpush()
    const handle = await mkProvider(server).create(SPEC, { mode: "push" } as never)
    expect(handle.state!.mode).toBe("poll")
    expect(server.calls[0]!.body).toMatchObject({ mode: "poll" })
  })

  it("poll and ack are no-ops for a push subscription (agentpush owns the queue)", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, { mode: "push", callbackUrl: pub.url })
    server.calls.length = 0
    expect(await provider.poll!(handle, 10)).toEqual({ events: [], cursor: "0" })
    await provider.ack!(handle, "5")
    expect(server.calls).toHaveLength(0)
  })

  it("attach re-points a push callback whose public origin changed", async () => {
    const server = fakeAgentpush()
    const provider = mkProvider(server)
    const handle = await provider.create(SPEC, { mode: "push", callbackUrl: pub.url })
    await provider.attach(handle, { mode: "push", callbackUrl: "https://new.example.com" })
    const [patch] = server.callsTo("PATCH", /sub_1$/)
    expect(patch!.body).toEqual({ callback_url: `https://new.example.com/inbound/sentinel-${handle.state!.hookKey as string}` })

    server.calls.length = 0
    await provider.attach(handle, { mode: "push", callbackUrl: "https://new.example.com" })
    expect(server.callsTo("PATCH", /sub_1$/)).toHaveLength(0)
  })
})

// ── Signature v2 / parseInbound ────────────────────────────────────────

describe("agentpush signature v2 (parseInbound)", () => {
  const NOW = Date.UTC(2026, 8, 29, 12, 0, 0)
  const nowSec = NOW / 1000
  const SECRET = "s3cret"
  const body = JSON.stringify(envelope("evt_push"))
  const handle: SentinelHandle = {
    provider: "agentpush",
    remoteId: "sub_1",
    state: { mode: "push", hookKey: "hk", callbackSecret: SECRET },
  }
  const provider = agentpushSentinelProvider({ creds: { apiKey: "k" }, importedBearer: NO_ALIAS, now: () => new Date(NOW) })
  const v2Headers = (ts: number, secret = SECRET, b = body): Record<string, string> => ({
    "x-agentpush-timestamp": String(ts),
    "x-agentpush-signature": `v2=${computeSignatureV2(secret, ts, b)}`,
  })

  it("accepts a correctly signed delivery and yields the envelope unchanged", () => {
    const res = provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec) }, handle)
    expect(res).toMatchObject({ ok: true, events: [{ id: "evt_push", subject: "github:o/r#12", type: "github.pull_request.opened" }] })
  })

  it("header names are case-insensitive", () => {
    const h = v2Headers(nowSec)
    const res = provider.parseInbound!(
      { rawBody: body, headers: { "X-Agentpush-Timestamp": h["x-agentpush-timestamp"], "X-Agentpush-Signature": h["x-agentpush-signature"] } },
      handle,
    )
    expect(res.ok).toBe(true)
  })

  it("rejects a wrong secret, a tampered body, and a garbled signature", () => {
    expect(provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec, "other") }, handle)).toEqual({ ok: false, reason: "bad_signature" })
    expect(provider.parseInbound!({ rawBody: body + " ", headers: v2Headers(nowSec) }, handle)).toEqual({ ok: false, reason: "bad_signature" })
    expect(
      provider.parseInbound!({ rawBody: body, headers: { "x-agentpush-timestamp": String(nowSec), "x-agentpush-signature": "v2=zz" } }, handle),
    ).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects a valid signature outside the 5-minute skew, in either direction", () => {
    expect(provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec - 301) }, handle)).toEqual({ ok: false, reason: "stale_timestamp" })
    expect(provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec + 301) }, handle)).toEqual({ ok: false, reason: "stale_timestamp" })
    expect(provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec - 299) }, handle).ok).toBe(true)
  })

  it("missing signature / timestamp headers → missing_signature", () => {
    expect(provider.parseInbound!({ rawBody: body, headers: {} }, handle)).toEqual({ ok: false, reason: "missing_signature" })
    expect(
      provider.parseInbound!({ rawBody: body, headers: { "x-agentpush-signature": `v2=${computeSignatureV2(SECRET, nowSec, body)}` } }, handle),
    ).toEqual({ ok: false, reason: "missing_signature" })
  })

  it("also accepts the legacy `sha256=` header (body-only HMAC), and rejects a bad one", () => {
    const legacy = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`
    expect(provider.parseInbound!({ rawBody: body, headers: { "x-agentpush-signature": legacy } }, handle).ok).toBe(true)
    const bad = `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`
    expect(provider.parseInbound!({ rawBody: body, headers: { "x-agentpush-signature": bad } }, handle)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("a verified but malformed payload is invalid_json / invalid_envelope", () => {
    const junk = "not json"
    expect(provider.parseInbound!({ rawBody: junk, headers: v2Headers(nowSec, SECRET, junk) }, handle)).toEqual({ ok: false, reason: "invalid_json" })
    const notEnvelope = JSON.stringify({ hello: "world" })
    expect(provider.parseInbound!({ rawBody: notEnvelope, headers: v2Headers(nowSec, SECRET, notEnvelope) }, handle)).toEqual({
      ok: false,
      reason: "invalid_envelope",
    })
  })

  it("a poll-mode handle (no secret) is an unknown hook", () => {
    expect(
      provider.parseInbound!({ rawBody: body, headers: v2Headers(nowSec) }, { provider: "agentpush", remoteId: "s", state: { mode: "poll" } }),
    ).toEqual({ ok: false, reason: "unknown_hook" })
  })

  it("verifySignatureV2 reports the specific failure", () => {
    expect(verifySignatureV2(SECRET, {}, body, NOW)).toEqual({ ok: false, reason: "missing_timestamp" })
    expect(verifySignatureV2(SECRET, { "x-agentpush-timestamp": "abc" }, body, NOW)).toEqual({ ok: false, reason: "invalid_timestamp" })
    expect(verifySignatureV2(SECRET, v2Headers(nowSec), body, NOW)).toEqual({ ok: true, timestampSec: nowSec })
  })
})

// ── Durable cursor across a restart ────────────────────────────────────

describe("agentpush provider — durability", () => {
  function newSentinel(store: SentinelStore, handle: SentinelHandle, id: string) {
    return store.create({ id, spec: SPEC, provider: "agentpush", handle })
  }

  it("a daemon restart resumes from the persisted seq: no loss, no redelivery", async () => {
    const server = fakeAgentpush()
    const file = join(tmp(), "sentinels.json")
    const id = mintSentinelId()

    const store1 = createSentinelStore({ filePath: file })
    const handle = await mkProvider(server).create(SPEC, POLL, { sentinelId: id })
    newSentinel(store1, handle, id)
    server.push("sub_1", envelope("e1"), envelope("e2"))

    const run1 = mkRuntime(store1, () => mkProvider(server))
    await run1.runtime.pollOnce()
    expect(run1.texts).toHaveLength(2)
    expect(store1.get(id)!.handle.cursor).toBe("2")
    store1.flushSync() // the shutdown path

    // Events arrive while the daemon is down — agentpush queues them.
    server.push("sub_1", envelope("e3"), envelope("e4"))
    server.calls.length = 0

    const store2 = createSentinelStore({ filePath: file })
    expect(store2.get(id)!.handle.cursor).toBe("2")
    const run2 = mkRuntime(store2, () => mkProvider(server))
    await run2.runtime.start() // re-attach
    run2.runtime.stop()
    expect(server.callsTo("GET", /^\/subscriptions\/sub_1$/)).toHaveLength(1)

    await run2.runtime.pollOnce()
    expect(server.callsTo("GET", /events$/)[0]!.query.after).toBe("2")
    expect(run2.texts).toEqual(["[github] event e3", "[github] event e4"])
    expect(store2.get(id)!.handle.cursor).toBe("4")
    expect(server.callsTo("POST", /ack$/).map(c => c.body)).toEqual([{ upToSeq: 4 }])
  })

  it("acks only after delivery: a delivery that throws is not acked and is retried", async () => {
    const server = fakeAgentpush()
    const store = createSentinelStore({ persist: false })
    const id = mintSentinelId()
    newSentinel(store, await mkProvider(server).create(SPEC, POLL, { sentinelId: id }), id)
    server.push("sub_1", envelope("e1"))

    let fail = true
    const texts: string[] = []
    const runtime = createSentinelRuntime({
      store,
      registry: {
        async sendMessage(msg: SessionMessage): Promise<SendMessageResult> {
          if (fail) throw new Error("transient")
          texts.push(msg.text)
          return { messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }
        },
      },
      resolveProvider: async () => mkProvider(server),
      isSessionAlive: () => true,
      restartSession: async s => s,
      log: () => {},
    })
    await runtime.pollOnce()
    expect(server.callsTo("POST", /ack$/)).toHaveLength(0)
    expect(store.get(id)!.handle.cursor).toBe("0")

    fail = false
    await runtime.pollOnce()
    expect(texts).toEqual(["[github] event e1"])
    expect(server.callsTo("POST", /ack$/)).toHaveLength(1)
  })

  it("a lost local cursor write does not redeliver: agentpush never re-serves acked rows", async () => {
    const server = fakeAgentpush()
    const id = mintSentinelId()
    const store1 = createSentinelStore({ persist: false })
    const handle = await mkProvider(server).create(SPEC, POLL, { sentinelId: id })
    newSentinel(store1, handle, id)
    server.push("sub_1", envelope("e1"), envelope("e2"))
    await mkRuntime(store1, () => mkProvider(server)).runtime.pollOnce()

    // Restart with the pre-poll state on disk (cursor "0", empty seen window).
    const store2 = createSentinelStore({ persist: false })
    newSentinel(store2, handle, id)
    server.push("sub_1", envelope("e3"))
    const run2 = mkRuntime(store2, () => mkProvider(server))
    await run2.runtime.pollOnce()
    expect(run2.texts).toEqual(["[github] event e3"])
  })

  it("a crash between delivery and ack re-serves the rows, and the persisted seen window drops them", async () => {
    const server = fakeAgentpush()
    const id = mintSentinelId()
    const store1 = createSentinelStore({ persist: false })
    const handle = await mkProvider(server).create(SPEC, POLL, { sentinelId: id })
    newSentinel(store1, handle, id)
    server.push("sub_1", envelope("e1"))
    server.state.failAck = true
    const run1 = mkRuntime(store1, () => mkProvider(server))
    await run1.runtime.pollOnce()
    expect(run1.texts).toHaveLength(1)

    // Restart: cursor write lost but `seen` (persisted with delivery) survived.
    const store2 = createSentinelStore({ persist: false })
    newSentinel(store2, handle, id)
    store2.markSeen(id, "e1")
    server.state.failAck = false
    const run2 = mkRuntime(store2, () => mkProvider(server))
    await run2.runtime.pollOnce()
    expect(run2.texts).toHaveLength(0) // re-served by the server, deduped locally
    expect(server.callsTo("GET", /events$/).at(-1)!.query.after).toBe("0")
    expect(server.callsTo("POST", /ack$/).at(-1)!.body).toEqual({ upToSeq: 1 })
  })
})

// ── Credentials + readiness + setup ────────────────────────────────────

describe("agentpush credentials and readiness", () => {
  it("reuses an imported agentpush MCP alias bearer when no key is stored", async () => {
    const server = fakeAgentpush()
    const provider = agentpushSentinelProvider({ creds: null, fetch: server.fetch, importedBearer: async () => "alias_bearer" })
    await provider.create(SPEC, POLL)
    expect(server.calls[0]!.auth).toBe("Bearer alias_bearer")
    expect(await provider.readiness!()).toEqual({ ready: true })
  })

  it("a stored key wins over the alias bearer", async () => {
    const server = fakeAgentpush()
    const provider = agentpushSentinelProvider({ creds: { apiKey: "stored" }, fetch: server.fetch, importedBearer: async () => "alias" })
    await provider.create(SPEC, POLL)
    expect(server.calls[0]!.auth).toBe("Bearer stored")
  })

  it("not ready, with the reason, when neither source has a key", async () => {
    const provider = agentpushSentinelProvider({ creds: null, importedBearer: NO_ALIAS })
    expect(await provider.check()).toBe(false)
    expect(await provider.readiness!()).toMatchObject({ ready: false, reason: expect.stringMatching(/API key/) })
  })

  it("declares the setup fields (apiKey sensitive) and is durable/poll+push", () => {
    const provider = agentpushSentinelProvider({ creds: null, importedBearer: NO_ALIAS })
    expect(provider.setupFields?.find(f => f.name === "apiKey")).toMatchObject({ required: true, sensitive: true })
    expect(provider.setupFields?.map(f => f.name)).toEqual(expect.arrayContaining(["baseUrl", "delivery"]))
    expect(provider.capabilities).toMatchObject({ push: true, poll: true, durable: true, needsPublicUrl: false, requiresAuth: true })
  })

  it("stores the API key in a 0600 file and never surfaces it via the lister", async () => {
    const home = tmp()
    const creds = makeSentinelCredsStore(home)
    await creds.write("agentpush", { apiKey: "ak_secret_value", baseUrl: "https://ap.example" })
    const dir = join(home, "sentinel-creds")
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
  })

  describe("list_sentinel_adapters", () => {
    const saved = { home: process.env.AGENTPROTO_HOME }
    afterEach(() => {
      if (saved.home === undefined) delete process.env.AGENTPROTO_HOME
      else process.env.AGENTPROTO_HOME = saved.home
    })

    it("lists agentpush as available (not ready) without a key, ready once a key is stored", async () => {
      const home = tmp()
      process.env.AGENTPROTO_HOME = home // no imported-mcps.json here → no alias bearer
      const creds = makeSentinelCredsStore(home)
      const lister = makeSentinelLister({ credsStore: creds, ledger: makeSetupLedger({ home }) })

      const before = (await lister()).find(e => e.slug === "agentpush")!
      expect(before.status).toBe("available")
      expect((before.info as SentinelAdapterInfo).readiness).toMatchObject({ ready: false, reason: expect.stringMatching(/API key/) })

      await creds.write("agentpush", { apiKey: "ak_test_key" })
      const after = (await lister()).find(e => e.slug === "agentpush")!
      expect(after.status).toBe("ready")
      expect((after.info as SentinelAdapterInfo).readiness).toEqual({ ready: true })
      // The listing never carries the secret.
      expect(JSON.stringify(after)).not.toContain("ak_test_key")
    })
  })
})

// ── Auto-selection ─────────────────────────────────────────────────────

describe("provider auto-selection (agentpush > webhook > local-gh)", () => {
  const stub = (slug: string, ready: boolean | "throws"): SentinelProviderHandle =>
    ({
      slug,
      readiness: async () => {
        if (ready === "throws") throw new Error("probe failed")
        return ready ? { ready: true } : { ready: false, reason: "nope" }
      },
    }) as unknown as SentinelProviderHandle
  const resolverOf = (handles: Record<string, SentinelProviderHandle | null>) => async (slug: string) => handles[slug] ?? null
  const stable = () => ({ url: "https://h.example.com", stable: true, source: "env" as const })
  const unstable = () => ({ url: "https://q.trycloudflare.com", stable: false, source: "tunnel" as const })

  it("agentpush wins whenever it is set up — even with a stable URL and a ready webhook", async () => {
    const slug = await autoSelectProviderSlug({
      resolveProvider: resolverOf({ agentpush: stub("agentpush", true), webhook: stub("webhook", true) }),
      publicUrl: stable,
    })
    expect(slug).toBe("agentpush")
  })

  it("falls to webhook when agentpush is not set up but a stable URL exists and webhook is ready", async () => {
    const slug = await autoSelectProviderSlug({
      resolveProvider: resolverOf({ agentpush: stub("agentpush", false), webhook: stub("webhook", true) }),
      publicUrl: stable,
    })
    expect(slug).toBe("webhook")
  })

  it("falls to local-gh for an unstable URL, no URL, a not-ready webhook, or a throwing probe", async () => {
    const wh = (r: boolean | "throws") => resolverOf({ agentpush: null, webhook: stub("webhook", r) })
    expect(await autoSelectProviderSlug({ resolveProvider: wh(true), publicUrl: unstable })).toBe("local-gh")
    expect(await autoSelectProviderSlug({ resolveProvider: wh(true), publicUrl: () => undefined })).toBe("local-gh")
    expect(await autoSelectProviderSlug({ resolveProvider: wh(false), publicUrl: stable })).toBe("local-gh")
    expect(await autoSelectProviderSlug({ resolveProvider: wh("throws"), publicUrl: stable })).toBe("local-gh")
    expect(
      await autoSelectProviderSlug({
        resolveProvider: resolverOf({ agentpush: stub("agentpush", "throws"), webhook: stub("webhook", true) }),
        publicUrl: stable,
      }),
    ).toBe("webhook")
  })
})

// ── Auto-link ──────────────────────────────────────────────────────────

describe("sentinel auto-link with agentpush", () => {
  const OPENED = { adapter: "claude-code", number: 42, url: "https://github.com/acme/widgets/pull/42" }

  it("watches the PR through agentpush when it is set up, stamping the sentinel id as consumerRef", async () => {
    const server = fakeAgentpush()
    const store = createSentinelStore({ persist: false })
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: async slug => (slug === "agentpush" ? mkProvider(server) : null),
      autoWatchPrs: async () => true,
      publicUrl: () => undefined,
      log: () => {},
    })
    await linker.linkNow("sess_1", OPENED, {})

    const [s] = store.list()
    expect(store.list()).toHaveLength(1)
    expect(s!.provider).toBe("agentpush")
    expect(s!.spec.provider).toBe("agentpush")
    expect(server.calls[0]!.body).toMatchObject({
      source: "github",
      subject: "github:acme/widgets#42",
      consumer_ref: `agentproto:sentinel:${s!.id}`,
      until: { kind: "subject_terminal" },
    })
  })

  it("falls back to local-gh when the agentpush create fails — the PR is never left unwatched", async () => {
    const server = fakeAgentpush()
    server.state.failAll = 500
    const store = createSentinelStore({ persist: false })
    const created: string[] = []
    const localGh = {
      slug: "local-gh",
      capabilities: { subjects: ["github:*"], push: false, poll: true, durable: false, needsPublicUrl: false, requiresAuth: false },
      create: async (spec: SentinelSpec) => {
        created.push(spec.provider ?? "")
        return { provider: "local-gh", remoteId: "x", cursor: "0" }
      },
    } as unknown as SentinelProviderHandle
    const linker = createSentinelAutoLinker({
      store,
      resolveProvider: async slug => (slug === "agentpush" ? mkProvider(server) : slug === "local-gh" ? localGh : null),
      autoWatchPrs: async () => true,
      publicUrl: () => undefined,
      log: () => {},
    })
    await linker.linkNow("sess_1", OPENED, {})
    expect(store.list().map(s => s.provider)).toEqual(["local-gh"])
    expect(created).toEqual(["local-gh"])
  })
})

// ── Inbound route ──────────────────────────────────────────────────────

describe("sentinel inbound route with agentpush push subscriptions", () => {
  const NOW = Date.now()
  const nowSec = Math.floor(NOW / 1000)
  const pub = "https://hooks.example.com"

  async function setup(opts: { withWebhook?: boolean } = {}) {
    const server = fakeAgentpush()
    const provider = mkProvider(server, { now: () => new Date(NOW) })
    const store = createSentinelStore({ persist: false })
    const id = mintSentinelId()
    const handle = await provider.create(SPEC, { mode: "push", callbackUrl: pub }, { sentinelId: id })
    store.create({ id, spec: SPEC, provider: "agentpush", handle })
    const { texts, registry } = stubRegistry()
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === "agentpush" ? provider : null),
      isSessionAlive: () => true,
      restartSession: async s => s,
      log: () => {},
    })
    const webhook = opts.withWebhook
      ? webhookSentinelProvider({ gh: async () => "{}", hooks: createWebhookHookStore({ persist: false }), publicUrl: () => ({ url: pub, stable: true, source: "env" }) })
      : null
    const deps = {
      store,
      runtime,
      resolveProvider: async (slug: string) => (slug === "agentpush" ? provider : slug === "webhook" ? webhook : null),
    }
    const hookKey = handle.state!.hookKey as string
    const secret = handle.state!.callbackSecret as string
    const signed = (evt: Record<string, unknown>, ts = nowSec, key = secret) => {
      const rawBody = JSON.stringify(evt)
      return { rawBody, headers: { "x-agentpush-timestamp": String(ts), "x-agentpush-signature": `v2=${computeSignatureV2(key, ts, rawBody)}` } }
    }
    return { deps, texts, hookKey, secret, signed, store, id }
  }

  it.each([false, true])("delivers a signed agentpush event to the bound sentinel (webhook provider present: %s)", async withWebhook => {
    const s = await setup({ withWebhook })
    const res = await handleSentinelInbound(s.hookKey, s.signed(envelope("evt_1")), s.deps)
    expect(res).toEqual({ status: 200, body: { ok: true, events: 1, sentinels: 1, delivered: 1 } })
    expect(s.texts).toEqual(["[github] event evt_1"])

    // Redelivery of the same event id is deduped by the runtime pipeline.
    const again = await handleSentinelInbound(s.hookKey, s.signed(envelope("evt_1")), s.deps)
    expect(again!.status).toBe(200)
    expect(s.texts).toHaveLength(1)
  })

  it("401 on a bad signature and on a stale timestamp; nothing is delivered", async () => {
    const s = await setup()
    const bad = await handleSentinelInbound(s.hookKey, s.signed(envelope("e"), nowSec, "wrong-secret"), s.deps)
    expect(bad).toMatchObject({ status: 401, body: { error: "bad_signature", reason: "bad_signature" } })
    const stale = await handleSentinelInbound(s.hookKey, s.signed(envelope("e"), nowSec - 3600), s.deps)
    expect(stale).toMatchObject({ status: 401, body: { reason: "stale_timestamp" } })
    const missing = await handleSentinelInbound(s.hookKey, { rawBody: "{}", headers: {} }, s.deps)
    expect(missing).toMatchObject({ status: 401 })
    expect(s.texts).toHaveLength(0)
  })

  it("an unknown hook key is null (generic 404)", async () => {
    const s = await setup({ withWebhook: true })
    expect(await handleSentinelInbound("nope", s.signed(envelope("e")), s.deps)).toBeNull()
  })

  it("400 for a verified payload that is not an envelope", async () => {
    const s = await setup()
    const res = await handleSentinelInbound(s.hookKey, s.signed({ hello: "world" }), s.deps)
    expect(res).toEqual({ status: 400, body: { error: "invalid_envelope" } })
  })
})
