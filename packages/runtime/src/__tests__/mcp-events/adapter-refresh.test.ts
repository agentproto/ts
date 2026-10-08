/**
 * Phase 0a — MCP refresh renews the backing remote subscription before any
 * local TTL/secret rotation is committed.
 */

import { describe, expect, it } from "vitest"

import { DEFAULT_TTL_MS, eventsSubscribe, type EventsSubscribeContext } from "../../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../../mcp-events/events-registry.js"
import { createSentinelStore } from "../../sentinel-store.js"
import { createFakeSentinelProvider, type FakeSentinelProvider } from "../../sentinel-providers/fake.js"
import { SentinelBackingExpiredError } from "../../sentinel-providers/types.js"

const CALLBACK = "https://receiver.example.com/mcp-events/cb"
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const SECRET_2 = "whsec_" + Buffer.from(new Uint8Array(32).fill(9)).toString("base64")
const SUB = {
  name: "github.pull_request.closed",
  arguments: { repo: "agentproto/ts", number: 1428 },
  delivery: { mode: "webhook" as const, url: CALLBACK, secret: SECRET },
}
const NOW = 1_700_000_000_000

function setup(onRenew?: (h: unknown, u: unknown) => void) {
  const store = createSentinelStore({ persist: false })
  const events: string[] = []
  const provider: FakeSentinelProvider = createFakeSentinelProvider({
    slug: "local-gh",
    onRenew: (h, u) => {
      events.push("renew")
      onRenew?.(h, u)
    },
  })
  const ctx = (nowMs: number): EventsSubscribeContext => ({
    principal: daemonBearerPrincipal(),
    store,
    resolveProvider: async () => provider,
    verify: async () => ({ ok: true, verificationBytes: new Uint8Array() }),
    nowMs: () => nowMs,
  })
  return { store, provider, ctx, events }
}

describe("events/subscribe refresh renews the backing subscription first", () => {
  it("advances the remote and local expirations together", async () => {
    const { store, provider, ctx } = setup()
    const first = await eventsSubscribe(SUB, ctx(NOW))
    expect(provider.renewCalls).toHaveLength(0) // creating does not renew

    const refreshed = await eventsSubscribe(SUB, ctx(NOW + 5_000))

    expect(provider.renewCalls).toHaveLength(1)
    expect(provider.renewCalls[0]!.until).toEqual({ kind: "at", ms: NOW + 5_000 + DEFAULT_TTL_MS })
    expect(store.get(first.id)!.spec.until).toEqual(provider.renewCalls[0]!.until)
    expect(refreshed.refreshBefore).toBe(new Date(NOW + 5_000 + DEFAULT_TTL_MS).toISOString())
  })

  it("renew runs before the local state is touched", async () => {
    let seenLocalUntilDuringRenew: unknown
    const holder: { store?: ReturnType<typeof createSentinelStore>; id?: string } = {}
    const { store, ctx } = setup(() => {
      seenLocalUntilDuringRenew = holder.store!.get(holder.id!)!.spec.until
    })
    holder.store = store
    const first = await eventsSubscribe(SUB, ctx(NOW))
    holder.id = first.id
    const before = store.get(first.id)!.spec.until

    await eventsSubscribe(SUB, ctx(NOW + 5_000))

    expect(seenLocalUntilDuringRenew).toEqual(before)
  })

  it("a transient renew failure leaves the previous TTL and secret intact and is retryable (backing_renew_failed)", async () => {
    let fail = true
    const { store, ctx } = setup(() => {
      if (fail) throw new Error("agentpush 503")
    })
    const first = await eventsSubscribe(SUB, ctx(NOW))
    const ref = (store.get(first.id)!.spec.target as unknown as { secretRef: string }).secretRef
    const beforeUntil = store.get(first.id)!.spec.until

    await expect(
      eventsSubscribe({ ...SUB, delivery: { ...SUB.delivery, secret: SECRET_2 } }, ctx(NOW + 5_000)),
    ).rejects.toMatchObject({ code: -32016, data: { reason: "backing_renew_failed", subscriptionId: first.id } })

    expect(store.get(first.id)!.spec.until).toEqual(beforeUntil)
    expect(store.getSentinelSecret(ref)?.secret).toBe(SECRET)
    expect(store.getSentinelSecret(ref)?.prevSecret).toBeUndefined()

    fail = false
    const ok = await eventsSubscribe({ ...SUB, delivery: { ...SUB.delivery, secret: SECRET_2 } }, ctx(NOW + 6_000))
    expect(ok.id).toBe(first.id)
    expect(store.getSentinelSecret(ref)?.secret).toBe(SECRET_2)
  })

  it("an expired/deleted backing subscription is a typed -32016 backing_subscription_expired; local state intact and no second remote is provisioned", async () => {
    const { store, provider, ctx } = setup(() => {
      throw new SentinelBackingExpiredError("the agentpush subscription sub_1 was deleted", "sub_1")
    })
    const first = await eventsSubscribe(SUB, ctx(NOW))
    const ref = (store.get(first.id)!.spec.target as unknown as { secretRef: string }).secretRef
    const beforeUntil = store.get(first.id)!.spec.until
    const createsBefore = provider.attachCalls.length

    const err = await eventsSubscribe({ ...SUB, delivery: { ...SUB.delivery, secret: SECRET_2 } }, ctx(NOW + 5_000)).catch(e => e)

    expect(err).toMatchObject({
      code: -32016,
      data: { reason: "backing_subscription_expired", subscriptionId: first.id },
    })
    expect(String(err.message)).toMatch(/unsubscribe and subscribe again/)
    expect(provider.attachCalls.length).toBe(createsBefore) // nothing silently re-created
    expect(store.list()).toHaveLength(1)
    expect(store.get(first.id)!.spec.until).toEqual(beforeUntil)
    expect(store.getSentinelSecret(ref)?.secret).toBe(SECRET)
  })

  it("a provider without renew refreshes locally as before", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const ctx = (nowMs: number): EventsSubscribeContext => ({
      principal: daemonBearerPrincipal(),
      store,
      resolveProvider: async () => provider,
      verify: async () => ({ ok: true, verificationBytes: new Uint8Array() }),
      nowMs: () => nowMs,
    })
    const first = await eventsSubscribe(SUB, ctx(NOW))
    await eventsSubscribe(SUB, ctx(NOW + 5_000))
    expect(store.get(first.id)!.spec.until).toEqual({ kind: "at", ms: NOW + 5_000 + DEFAULT_TTL_MS })
  })
})
