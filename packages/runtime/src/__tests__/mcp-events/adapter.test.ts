/**
 * MCP Events adapter (W-C of .plans/sentinel-mcp-events).
 *
 * One test per Contract Map §2 row that lands in `mcp-events/adapter.ts`:
 *   events-list-tenant-scoped, events-list-pagination, sub-id-no-duplicate,
 *   unreplayable-cursor-null, ttl-clamp, ttl-null-no-refresh-needed,
 *   refresh-before-expires, rotation-window-both-secrets,
 *   unsubscribe-idempotent, envelope-mapping — plus the JSON-RPC error
 *   mapping (-32602 / -32015 with data.reason).
 *
 * The POST boundary (`verifyCallback`) is injected; the store is in-memory;
 * the provider is the fake. No real network, no module mocks.
 */

import { describe, expect, it } from "vitest"

import {
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  toMcpEvent,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  type EventsSubscribeContext,
  type EventsUnsubscribeContext,
} from "../../mcp-events/adapter.js"
import { GITHUB_SCHEME, daemonBearerPrincipal, sessionPrincipal } from "../../mcp-events/events-registry.js"
import { createSentinelStore, type SentinelStore, type SentinelWebhookTargetAtRest } from "../../sentinel-store.js"
import { createFakeSentinelProvider, makeFakeEvent, type FakeSentinelProvider } from "../../sentinel-providers/fake.js"
import type { ChallengeOutcome, ChallengeFailureReason } from "../../webhook-egress/challenge.js"

const PRINCIPAL = daemonBearerPrincipal()
const CALLBACK = "https://receiver.example.com/mcp-events/cb"
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const SECRET_2 = "whsec_" + Buffer.from(new Uint8Array(32).fill(9)).toString("base64")

const verifyOk = async (): Promise<ChallengeOutcome> => ({ ok: true, verificationBytes: new Uint8Array() })

function makeStore(): SentinelStore {
  return createSentinelStore({ persist: false })
}

function subscribeCtx(
  store: SentinelStore,
  provider: FakeSentinelProvider,
  overrides: Partial<EventsSubscribeContext> = {},
): EventsSubscribeContext {
  return { principal: PRINCIPAL, store, resolveProvider: async () => provider, verify: verifyOk, ...overrides }
}

const SUB = {
  name: "github.pull_request.closed",
  arguments: { repo: "agentproto/ts", number: 1428 },
  delivery: { mode: "webhook" as const, url: CALLBACK, secret: SECRET },
}

function targetRef(store: SentinelStore, id: string): string {
  const target = store.get(id)?.spec.target as unknown as SentinelWebhookTargetAtRest
  return target.secretRef
}

describe("events-list-tenant-scoped", () => {
  it("returns every registered definition for both v1 principals, wire-shaped", async () => {
    const daemon = await eventsList({}, { principal: PRINCIPAL })
    const session = await eventsList({}, { principal: sessionPrincipal("sess_1") })
    const expected = GITHUB_SCHEME.events.map((e) => e.definition.name)
    expect(daemon.events.map((e) => e.name)).toEqual(expected)
    expect(session.events.map((e) => e.name)).toEqual(expected)
    for (const def of daemon.events) {
      expect(def).not.toHaveProperty("replayable")
      expect(def.delivery).toEqual(["webhook"])
    }
  })
})

describe("events-list-pagination", () => {
  it("walks the catalog with an opaque nextCursor and terminates", async () => {
    const first = await eventsList({ pageSize: 2 }, { principal: PRINCIPAL })
    expect(first.events).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await eventsList({ pageSize: 2, cursor: first.nextCursor! }, { principal: PRINCIPAL })
    expect(second.events).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    const names = [...first.events, ...second.events].map((e) => e.name)
    expect(new Set(names).size).toBe(GITHUB_SCHEME.events.length)
  })

  it("rejects a cursor it did not issue (-32602)", async () => {
    await expect(eventsList({ cursor: "not-a-cursor" }, { principal: PRINCIPAL })).rejects.toMatchObject({
      code: -32602,
    })
  })
})

describe("events/subscribe", () => {
  it("sub-id-no-duplicate: same identity → same id, one stored subscription", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const first = await eventsSubscribe(SUB, subscribeCtx(store, provider))
    const second = await eventsSubscribe(SUB, subscribeCtx(store, provider))
    expect(second.id).toBe(first.id)
    expect(store.list()).toHaveLength(1)
    expect(store.get(first.id)?.spec.target.kind).toBe("webhook")
  })

  it("unreplayable-cursor-null: cursor is always null, truncated never set", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const created = await eventsSubscribe({ ...SUB, cursor: "provider-cursor-abc" }, subscribeCtx(store, provider))
    expect(created.cursor).toBeNull()
    expect(created.truncated).toBeUndefined()
    const refreshed = await eventsSubscribe({ ...SUB, cursor: "provider-cursor-abc" }, subscribeCtx(store, provider))
    expect(refreshed.cursor).toBeNull()
    expect(refreshed.truncated).toBeUndefined()
  })

  it("ttl-clamp: default 7d, number capped at 30d, floored at 60s", async () => {
    const now = 1_700_000_000_000
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })

    const dflt = await eventsSubscribe(SUB, subscribeCtx(store, provider, { nowMs: () => now }))
    expect(store.get(dflt.id)?.spec.until).toEqual({ kind: "at", ms: now + DEFAULT_TTL_MS })

    const big = await eventsSubscribe(
      { ...SUB, arguments: { repo: "agentproto/ts", number: 1 }, ttlMs: 999 * 24 * 60 * 60 * 1000 },
      subscribeCtx(store, provider, { nowMs: () => now }),
    )
    expect(store.get(big.id)?.spec.until).toEqual({ kind: "at", ms: now + MAX_TTL_MS })

    const small = await eventsSubscribe(
      { ...SUB, arguments: { repo: "agentproto/ts", number: 2 }, ttlMs: 1_000 },
      subscribeCtx(store, provider, { nowMs: () => now }),
    )
    expect(store.get(small.id)?.spec.until).toEqual({ kind: "at", ms: now + MIN_TTL_MS })
  })

  it("ttl-null-no-refresh-needed: ttlMs null → until never, refreshBefore null", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const result = await eventsSubscribe({ ...SUB, ttlMs: null }, subscribeCtx(store, provider))
    expect(result.refreshBefore).toBeNull()
    expect(store.get(result.id)?.spec.until).toEqual({ kind: "never" })
  })

  it("refresh-before-expires: refreshBefore === granted expiration (until.ms), refresh resets it", async () => {
    const now = 1_700_000_000_000
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const first = await eventsSubscribe(SUB, subscribeCtx(store, provider, { nowMs: () => now }))
    const until = store.get(first.id)?.spec.until
    expect(until?.kind).toBe("at")
    expect(first.refreshBefore).toBe(new Date(until!.kind === "at" ? until!.ms : 0).toISOString())

    const refreshed = await eventsSubscribe(SUB, subscribeCtx(store, provider, { nowMs: () => now + 5_000 }))
    expect(refreshed.id).toBe(first.id)
    expect(refreshed.refreshBefore).toBe(new Date(now + 5_000 + DEFAULT_TTL_MS).toISOString())
  })

  it("rotation-window-both-secrets: a changed secret rotates the sidecar (prevSecret + rotatedAt)", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const first = await eventsSubscribe(SUB, subscribeCtx(store, provider))
    const ref = targetRef(store, first.id)
    expect(store.getSentinelSecret(ref)?.secret).toBe(SECRET)

    const refreshed = await eventsSubscribe(
      { ...SUB, delivery: { ...SUB.delivery, secret: SECRET_2 } },
      subscribeCtx(store, provider),
    )
    expect(refreshed.id).toBe(first.id)
    const row = store.getSentinelSecret(ref)
    expect(row?.secret).toBe(SECRET_2)
    expect(row?.prevSecret).toBe(SECRET)
    expect(typeof row?.rotatedAt).toBe("number")
  })

  it("errors: unknown event / bad args / bad secret are -32602", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    await expect(eventsSubscribe({ ...SUB, name: "nope" }, subscribeCtx(store, provider))).rejects.toMatchObject({
      code: -32602,
      data: { reason: "unknown_event" },
    })
    await expect(
      eventsSubscribe({ ...SUB, arguments: { repo: "agentproto/ts" } }, subscribeCtx(store, provider)),
    ).rejects.toMatchObject({ code: -32602, data: { reason: "invalid_arguments" } })
    await expect(
      eventsSubscribe({ ...SUB, delivery: { ...SUB.delivery, secret: "garbage" } }, subscribeCtx(store, provider)),
    ).rejects.toMatchObject({ code: -32602, data: { reason: "invalid_secret" } })
    expect(store.list()).toHaveLength(0)
  })

  it("callback-fail-reason-categorized: every ChallengeFailureReason → -32015 data.reason", async () => {
    const reasons: ChallengeFailureReason[] = [
      "challenge_failed",
      "timeout",
      "non_https",
      "ssrf_blocked",
      "non_2xx",
    ]
    for (const reason of reasons) {
      const store = makeStore()
      const provider = createFakeSentinelProvider({ slug: "local-gh" })
      const verify = async (): Promise<ChallengeOutcome> => ({ ok: false, reason, detail: `simulated ${reason}` })
      await expect(eventsSubscribe(SUB, subscribeCtx(store, provider, { verify }))).rejects.toMatchObject({
        code: -32015,
        data: { reason },
      })
      // verification failed BEFORE any store mutation
      expect(store.list()).toHaveLength(0)
    }
  })
})

describe("events/unsubscribe-idempotent", () => {
  it("recomputes the id, removes the record, and returns {} on the second call", async () => {
    const store = makeStore()
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const created = await eventsSubscribe(SUB, subscribeCtx(store, provider))
    const unsubscribeCtx: EventsUnsubscribeContext = {
      principal: PRINCIPAL,
      store,
      resolveProvider: async () => provider,
    }
    const input = {
      name: SUB.name,
      arguments: SUB.arguments,
      delivery: { mode: "webhook" as const, url: CALLBACK },
    }
    expect(await eventsUnsubscribe(input, unsubscribeCtx)).toEqual({})
    expect(store.get(created.id)).toBeUndefined()
    expect(store.list()).toHaveLength(0)
    expect(await eventsUnsubscribe(input, unsubscribeCtx)).toEqual({})
    expect(provider.canceled.has("github:agentproto/ts#1428")).toBe(true)
  })
})

describe("envelope-mapping", () => {
  it("maps CloudEvents → the MCP Events wire envelope (cursor null)", () => {
    const event = makeFakeEvent({
      id: "evt_1",
      type: "github.pull_request.closed",
      subject: "github:agentproto/ts#1428",
      time: "2026-10-01T12:05:00Z",
      data: { action: "closed", merged: true },
    })
    expect(toMcpEvent(event)).toEqual({
      eventId: "evt_1",
      name: "github.pull_request.closed",
      timestamp: "2026-10-01T12:05:00Z",
      data: {
        action: "closed",
        merged: true,
        subject: "github:agentproto/ts#1428",
        summary: event.summary,
      },
      cursor: null,
    })
  })
})
