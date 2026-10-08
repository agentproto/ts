import { describe, expect, it } from "vitest"

import {
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  type EventsSubscribeContext,
  type EventsUnsubscribeContext,
} from "../mcp-events/adapter.js"
import { daemonBearerPrincipal, sessionPrincipal } from "../mcp-events/events-registry.js"
import { createSentinelStore, type SentinelStore } from "../sentinel-store.js"
import { createFakeSentinelProvider, type FakeSentinelProvider } from "../sentinel-providers/fake.js"
import type { ChallengeOutcome } from "../webhook-egress/challenge.js"

const OPERATOR = daemonBearerPrincipal()
const ORIGIN = sessionPrincipal("mcp-events-origin")
const CALLBACK = "https://receiver.example.com/mcp-events/cb"
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")

const verifyOk = async (): Promise<ChallengeOutcome> => ({ ok: true, verificationBytes: new Uint8Array() })

const SUB = {
  name: "github.pull_request.closed",
  arguments: { repo: "agentproto/ts", number: 1428 },
  delivery: { mode: "webhook" as const, url: CALLBACK, secret: SECRET },
}
const UNSUB = {
  name: SUB.name,
  arguments: SUB.arguments,
  delivery: { mode: "webhook" as const, url: CALLBACK },
}

function subscribeCtx(
  principal: EventsSubscribeContext["principal"],
  store: SentinelStore,
  provider: FakeSentinelProvider,
): EventsSubscribeContext {
  return { principal, store, resolveProvider: async () => provider, verify: verifyOk }
}

function unsubscribeCtx(
  principal: EventsUnsubscribeContext["principal"],
  store: SentinelStore,
  provider: FakeSentinelProvider,
): EventsUnsubscribeContext {
  return { principal, store, resolveProvider: async () => provider }
}

describe("events surface principal isolation", () => {
  it("the public origin principal is not the operator's daemon-bearer principal", () => {
    expect(ORIGIN).not.toBe(OPERATOR)
  })

  it("the same subscription under the two principals gets two different ids and two records", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const operator = await eventsSubscribe(SUB, subscribeCtx(OPERATOR, store, provider))
    const origin = await eventsSubscribe(SUB, subscribeCtx(ORIGIN, store, provider))
    expect(origin.id).not.toBe(operator.id)
    expect(store.list().map(s => s.id).sort()).toEqual([operator.id, origin.id].sort())
  })

  it("unsubscribe as the origin principal does not cancel the operator's subscription", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const operator = await eventsSubscribe(SUB, subscribeCtx(OPERATOR, store, provider))

    expect(await eventsUnsubscribe(UNSUB, unsubscribeCtx(ORIGIN, store, provider))).toEqual({})

    expect(store.get(operator.id)).toBeDefined()
    expect(store.list()).toHaveLength(1)
    expect(provider.canceled.size).toBe(0)
  })

  it("a subscription made as the origin principal is removed only by the origin principal", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    const operator = await eventsSubscribe(SUB, subscribeCtx(OPERATOR, store, provider))
    const origin = await eventsSubscribe(SUB, subscribeCtx(ORIGIN, store, provider))

    await eventsUnsubscribe(UNSUB, unsubscribeCtx(ORIGIN, store, provider))

    expect(store.get(origin.id)).toBeUndefined()
    expect(store.get(operator.id)).toBeDefined()
  })

  it("events/list answers the event catalog, never any principal's subscriptions", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider({ slug: "local-gh" })
    await eventsSubscribe(SUB, subscribeCtx(OPERATOR, store, provider))

    const asOrigin = await eventsList({}, { principal: ORIGIN })
    const asOperator = await eventsList({}, { principal: OPERATOR })
    expect(asOrigin).toEqual(asOperator)
    for (const def of asOrigin.events) expect(def).not.toHaveProperty("id")
  })
})
