/** Official MCP Events error codes (-32023..-32027) and the `-32603` backing-subscription mapping. */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeSentinelProvider, createSentinelStore, SentinelBackingExpiredError } from "@agentproto/sentinel"

import { eventsPoll, eventsSubscribe, eventsUnsubscribe, toJournalEvent } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../mcp-events/events-registry.js"
import { createPollJournal } from "../mcp-events/poll-journal.js"
import { createPollLeaseManager } from "../mcp-events/poll-lease.js"

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
    expect(err).toMatchObject({ code: -32027, data: { reason: "timeout", legacyCode: -32015 } })
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
