/** Official MCP Events error codes (-32023..-32027) and the `-32603` backing-subscription mapping. */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createFakeSentinelProvider,
  createSentinelStore,
  deliveryPreferenceFor,
  SentinelBackingExpiredError,
  type SentinelSpec,
} from "@agentproto/sentinel"

import { eventsPoll, eventsSubscribe, eventsUnsubscribe, toJournalEvent } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../mcp-events/events-registry.js"
import { createPollJournal } from "../mcp-events/poll-journal.js"
import { createPollLeaseManager } from "../mcp-events/poll-lease.js"
import { subscriptionId } from "../mcp-events/subscription-id.js"
import { verifyCallback, type SsrfFetchView } from "../webhook-egress/challenge.js"
import { SsrfFetchError } from "../webhook-egress/ssrf-fetch.js"

const PRINCIPAL = daemonBearerPrincipal()
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const NAME = "github.pull_request.closed"
const ARGS = { repo: "agentproto/ts", number: 1 }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-events-codes-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function pollCtx(over: { maxLeases?: number; resolve?: () => Promise<unknown> } = {}) {
  const provider = createFakeSentinelProvider({ slug: "local-gh" })
  const journal = createPollJournal({ dir })
  const leases = createPollLeaseManager({
    journal,
    resolveProvider: (over.resolve ?? (async () => provider)) as never,
    toEvent: toJournalEvent,
    background: false,
    ...(over.maxLeases ? { maxLeases: over.maxLeases } : {}),
  })
  return { ctx: { principal: PRINCIPAL, journal, leases }, leases, provider }
}

describe("official error codes", () => {
  it("-32023 NotFound: unknown event (poll)", async () => {
    const { ctx } = pollCtx()
    await expect(eventsPoll({ name: "nope", arguments: {}, cursor: null }, ctx)).rejects.toMatchObject({
      code: -32023,
      data: { reason: "unknown_event" },
    })
  })

  it("-32024 Forbidden: a cursor issued to another caller", async () => {
    const { ctx, leases } = pollCtx()
    const first = await eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, ctx)
    await expect(
      eventsPoll({ name: NAME, arguments: ARGS, cursor: first.cursor }, { ...ctx, principal: "session:other" as never }),
    ).rejects.toMatchObject({ code: -32024 })
    await leases.stop()
  })

  it("-32025 ResourceExhausted: too many concurrent poll watches", async () => {
    const { ctx, leases } = pollCtx({ maxLeases: 1 })
    await eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, ctx)
    await expect(eventsPoll({ name: NAME, arguments: { ...ARGS, number: 2 }, cursor: null }, ctx)).rejects.toMatchObject({
      code: -32025,
      data: { reason: "poll_watch_quota" },
    })
    // the already-leased key still works
    await expect(eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, ctx)).resolves.toBeDefined()
    await leases.stop()
  })

  it("-32026 Unsupported: webhook subscribe with a mode that is not offered, and a provider that cannot be polled", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    await expect(
      eventsSubscribe(
        { name: NAME, arguments: ARGS, delivery: { mode: "poll" as never, url: "https://r.example.com/cb", secret: SECRET } },
        { principal: PRINCIPAL, store, resolveProvider: async () => provider },
      ),
    ).rejects.toMatchObject({ code: -32026, data: { reason: "unsupported_delivery_mode" } })

    const noPoll = { ...provider, capabilities: { ...provider.capabilities, poll: false } }
    const { ctx } = pollCtx({ resolve: async () => noPoll })
    await expect(eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, ctx)).rejects.toMatchObject({ code: -32026 })
  })

  it("-32027 CallbackEndpointError with data.reason; the legacy -32015 only rides in data.legacyCode", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const err = await eventsSubscribe(
      { name: NAME, arguments: ARGS, delivery: { mode: "webhook", url: "https://r.example.com/cb", secret: SECRET } },
      {
        principal: PRINCIPAL,
        store,
        resolveProvider: async () => provider,
        verify: async () => ({ ok: false, reason: "timeout", detail: "slow" }),
      },
    ).catch(e => e)
    expect(err).toMatchObject({ code: -32027, data: { reason: "timeout", legacyReason: "timeout", legacyCode: -32015 } })
    expect(err.message).not.toContain("slow")
  })

  it("-32603 + data.kind backing_subscription (no bare -32016)", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({
      slug: "local-gh",
      onRenew: () => {
        throw new SentinelBackingExpiredError("gone")
      },
    })
    const input = { name: NAME, arguments: ARGS, delivery: { mode: "webhook" as const, url: "https://r.example.com/cb", secret: SECRET } }
    const ctx = { principal: PRINCIPAL, store, resolveProvider: async () => provider, verify: async () => ({ ok: true as const, verificationBytes: new Uint8Array() }) }
    await eventsSubscribe(input, ctx)
    const err = await eventsSubscribe(input, ctx).catch(e => e)
    expect(err.code).toBe(-32603)
    expect(err.data).toMatchObject({ kind: "backing_subscription", reason: "backing_subscription_expired", legacyCode: -32016 })
  })

  it("-32602 stays for bad arguments / maxEvents / maxAgeMs", async () => {
    const { ctx } = pollCtx()
    await expect(eventsPoll({ name: NAME, arguments: { repo: "x" }, cursor: null }, ctx)).rejects.toMatchObject({ code: -32602 })
    await expect(eventsPoll({ name: NAME, arguments: ARGS, cursor: null, maxEvents: 0 }, ctx)).rejects.toMatchObject({ code: -32602 })
    await expect(eventsPoll({ name: NAME, arguments: ARGS, cursor: null, maxAgeMs: -5 }, ctx)).rejects.toMatchObject({ code: -32602 })
  })
})

describe("events/unsubscribe without `mode`", () => {
  it("accepts { name, arguments, delivery: { url } } and removes the subscription", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const url = "https://r.example.com/cb"
    const sub = await eventsSubscribe(
      { name: NAME, arguments: ARGS, delivery: { mode: "webhook", url, secret: SECRET } },
      { principal: PRINCIPAL, store, resolveProvider: async () => provider, verify: async () => ({ ok: true, verificationBytes: new Uint8Array() }) },
    )
    expect(store.get(sub.id)).toBeDefined()
    const result = await eventsUnsubscribe({ name: NAME, arguments: ARGS, delivery: { url } }, { principal: PRINCIPAL, store, resolveProvider: async () => provider })
    expect(result).toEqual({})
    expect(store.get(sub.id)).toBeUndefined()
  })

  it("a non-webhook mode is still refused (-32026)", async () => {
    const store = createSentinelStore({ persist: false })
    await expect(
      eventsUnsubscribe({ name: NAME, arguments: ARGS, delivery: { mode: "poll" as never, url: "https://r.example.com/cb" } }, { principal: PRINCIPAL, store, resolveProvider: async () => null }),
    ).rejects.toMatchObject({ code: -32026 })
  })
})

const verifyOk = async () => ({ ok: true as const, verificationBytes: new Uint8Array() })
const CALLBACK = "https://r.example.com/cb"

function subscribeCtx(verify: typeof verifyCallback = verifyOk) {
  const store = createSentinelStore({ persist: false })
  const provider = createFakeSentinelProvider({ slug: "local-gh" })
  return { store, provider, ctx: { principal: PRINCIPAL, store, resolveProvider: async () => provider, verify } }
}

/** The real `verifyCallback`, with only its POST boundary replaced. */
function verifyThrough(fetch: () => Promise<SsrfFetchView>): typeof verifyCallback {
  return input => verifyCallback(input, { fetch })
}

describe("events/subscribe: callback URL and -32027 reasons", () => {
  it("a non-https or malformed delivery.url is -32602 invalid_callback_url, before any network call", async () => {
    for (const url of ["http://r.example.com/cb", "not a url", "ftp://r.example.com/cb"]) {
      let verifyCalls = 0
      const { ctx, store } = subscribeCtx(async () => {
        verifyCalls++
        return { ok: true, verificationBytes: new Uint8Array() }
      })
      await expect(
        eventsSubscribe({ name: NAME, arguments: ARGS, delivery: { mode: "webhook", url, secret: SECRET } }, ctx),
      ).rejects.toMatchObject({ code: -32602, data: { reason: "invalid_callback_url" } })
      expect(verifyCalls).toBe(0)
      expect(store.list()).toHaveLength(0)
    }
  })

  const SIX = ["connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx", "challenge_failed"]
  const cases: Array<{ label: string; fetch: () => Promise<SsrfFetchView>; reason: string; legacyReason: string; leaks: string[] }> = [
    {
      label: "connection refused",
      fetch: async () => {
        throw new SsrfFetchError("connect", "connect ECONNREFUSED 203.0.113.7:443")
      },
      reason: "connection_refused",
      legacyReason: "timeout",
      leaks: ["203.0.113.7", "ECONNREFUSED", "r.example.com"],
    },
    {
      label: "timeout",
      fetch: async () => {
        throw new SsrfFetchError("timeout", "no response within 10000ms")
      },
      reason: "timeout",
      legacyReason: "timeout",
      leaks: ["10000ms", "r.example.com"],
    },
    {
      label: "4xx",
      fetch: async () => ({ status: 404, body: "no such hook on r.example.com" }),
      reason: "http_4xx",
      legacyReason: "non_2xx",
      leaks: ["404", "r.example.com"],
    },
    {
      label: "5xx",
      fetch: async () => ({ status: 503, body: "upstream down" }),
      reason: "http_5xx",
      legacyReason: "non_2xx",
      leaks: ["503", "upstream down", "r.example.com"],
    },
    {
      label: "private target",
      fetch: async () => {
        throw new SsrfFetchError("private_target", "r.example.com resolves to non-public address 10.0.0.5")
      },
      reason: "connection_refused",
      legacyReason: "ssrf_blocked",
      leaks: ["10.0.0.5", "r.example.com", "non-public"],
    },
    {
      label: "challenge not echoed",
      fetch: async () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }),
      reason: "challenge_failed",
      legacyReason: "challenge_failed",
      leaks: ["r.example.com", "wrong"],
    },
  ]

  for (const c of cases) {
    it(`-32027 ${c.label}: data.reason is a lastError category, the old value rides in data.legacyReason`, async () => {
      const { ctx, store } = subscribeCtx(verifyThrough(c.fetch))
      const err = await eventsSubscribe(
        { name: NAME, arguments: ARGS, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } },
        ctx,
      ).catch(e => e)
      expect(err).toMatchObject({ code: -32027, data: { reason: c.reason, legacyReason: c.legacyReason, legacyCode: -32015 } })
      expect(SIX).toContain(err.data.reason)
      expect(store.list()).toHaveLength(0)
    })

    it(`-32027 ${c.label}: the message names no host, address, status or endpoint text`, async () => {
      const { ctx } = subscribeCtx(verifyThrough(c.fetch))
      const err = await eventsSubscribe(
        { name: NAME, arguments: ARGS, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } },
        ctx,
      ).catch(e => e)
      expect(err.code).toBe(-32027)
      for (const leak of c.leaks) expect(err.message).not.toContain(leak)
      expect(JSON.stringify(err.data)).not.toMatch(/203\.0\.113\.7|10\.0\.0\.5|r\.example\.com/)
    })
  }
})

describe("error data members", () => {
  it("-32023 carries data.kind \"event\"", async () => {
    const { ctx } = subscribeCtx()
    await expect(
      eventsSubscribe({ name: "nope", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } }, ctx),
    ).rejects.toMatchObject({ code: -32023, data: { reason: "unknown_event", kind: "event" } })
    const { ctx: pctx } = pollCtx()
    await expect(eventsPoll({ name: "nope", arguments: {}, cursor: null }, pctx)).rejects.toMatchObject({
      code: -32023,
      data: { kind: "event" },
    })
  })

  it("-32025 names the limit and its maximum", async () => {
    const { ctx, leases } = pollCtx({ maxLeases: 1 })
    await eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, ctx)
    await expect(eventsPoll({ name: NAME, arguments: { ...ARGS, number: 2 }, cursor: null }, ctx)).rejects.toMatchObject({
      code: -32025,
      data: { reason: "poll_watch_quota", limit: "pollWatches", max: 1 },
    })
    await leases.stop()
  })

  it("-32026 identifies the option: data.feature \"deliveryMode\" and data.value", async () => {
    const { ctx } = subscribeCtx()
    await expect(
      eventsSubscribe({ name: NAME, arguments: ARGS, delivery: { mode: "push" as never, url: CALLBACK, secret: SECRET } }, ctx),
    ).rejects.toMatchObject({ code: -32026, data: { reason: "unsupported_delivery_mode", feature: "deliveryMode", value: "push" } })
  })
})

describe("events/subscribe with a cursor", () => {
  async function pollCursor(principal = PRINCIPAL): Promise<string> {
    const { ctx, leases } = pollCtx()
    const first = await eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, { ...ctx, principal })
    await leases.stop()
    return first.cursor
  }

  it("a valid poll cursor answers truncated:true on create and on refresh (cursor stays null)", async () => {
    const cursor = await pollCursor()
    const { ctx } = subscribeCtx()
    const input = { name: NAME, arguments: ARGS, delivery: { mode: "webhook" as const, url: CALLBACK, secret: SECRET }, cursor }
    const created = await eventsSubscribe(input, ctx)
    expect(created).toMatchObject({ truncated: true, cursor: null })
    const refreshed = await eventsSubscribe(input, ctx)
    expect(refreshed).toMatchObject({ id: created.id, truncated: true, cursor: null })
    // no cursor: nothing to report
    expect(await eventsSubscribe({ ...input, cursor: null }, ctx)).toMatchObject({ truncated: false })
  })

  it("an unreadable cursor is -32602 invalid_cursor", async () => {
    const { ctx, store } = subscribeCtx()
    await expect(
      eventsSubscribe({ name: NAME, arguments: ARGS, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET }, cursor: "garbage" }, ctx),
    ).rejects.toMatchObject({ code: -32602, data: { reason: "invalid_cursor" } })
    expect(store.list()).toHaveLength(0)
  })

  it("a cursor issued to another principal is -32024", async () => {
    const cursor = await pollCursor("session:other" as never)
    const { ctx, store } = subscribeCtx()
    await expect(
      eventsSubscribe({ name: NAME, arguments: ARGS, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET }, cursor }, ctx),
    ).rejects.toMatchObject({ code: -32024, data: { reason: "cursor_principal_mismatch" } })
    expect(store.list()).toHaveLength(0)
  })
})

describe("events/unsubscribe of an http:// subscription (guard)", () => {
  it("is still accepted and removes the row", async () => {
    const { store, provider } = subscribeCtx()
    const url = "http://legacy.example.com/cb"
    const id = subscriptionId({ principal: PRINCIPAL, callbackUrl: url, eventName: NAME, args: ARGS })
    const spec: SentinelSpec = {
      match: [],
      until: { kind: "never" },
      target: { kind: "webhook", url, secret: SECRET },
      provider: "local-gh",
    }
    const handle = await provider.create(spec, deliveryPreferenceFor(provider, 15_000), { sentinelId: id })
    store.create({ id, spec, provider: "local-gh", handle })
    await expect(
      eventsUnsubscribe({ name: NAME, arguments: ARGS, delivery: { url } }, { principal: PRINCIPAL, store, resolveProvider: async () => provider }),
    ).resolves.toEqual({})
    expect(store.get(id)).toBeUndefined()
  })
})
