import { describe, expect, it } from "vitest"
import { settlementProviderContractCases } from "../contract/index.js"
import { FakeSettlementProvider, InMemoryBillingState, InMemoryStorage, ManualClock } from "../testing/index.js"

// The SET-* cases against the fake provider and the in-memory stores.
const clock = new ManualClock(0)
const webhookSecret = `whsec-${globalThis.crypto.randomUUID()}`
const secretKey = `fk_test_${globalThis.crypto.randomUUID()}`
const allowedReturnOrigins = ["https://app.example.com"]
const provider = new FakeSettlementProvider(webhookSecret, "fake", { allowedReturnOrigins, secretKey, mode: "test" })

describe("SET contract (fake provider, in-memory stores)", () => {
  const cases = settlementProviderContractCases({
    provider,
    clock,
    stores: () => ({ storage: new InMemoryStorage(clock), state: new InMemoryBillingState() }),
    events: provider.events(),
    secrets: [webhookSecret, secretKey],
    returnUrls: { allowed: "https://app.example.com/back", refused: "https://evil.example.net/back" },
    misconfigured: () => new FakeSettlementProvider(webhookSecret, "fake", { allowedReturnOrigins, secretKey: `fk_live_${globalThis.crypto.randomUUID()}`, mode: "test" }),
    railWrites: () => provider.railWrites,
  })
  for (const c of cases) it(c.name, c.run)
})

describe("SET contract without a deferring store (host replays early facts)", () => {
  const plain = () => {
    const s = new InMemoryBillingState()
    return Object.assign(Object.create(s) as InMemoryBillingState, { deferFact: undefined, takeDeferred: undefined })
  }
  const cases = settlementProviderContractCases({
    provider,
    clock,
    stores: () => ({ storage: new InMemoryStorage(clock), state: plain() }),
    events: provider.events(),
    secrets: [webhookSecret, secretKey],
    returnUrls: { allowed: "https://app.example.com/back", refused: "https://evil.example.net/back" },
    misconfigured: () => new FakeSettlementProvider(webhookSecret, "fake", { allowedReturnOrigins, secretKey: `fk_live_${globalThis.crypto.randomUUID()}`, mode: "test" }),
    railWrites: () => provider.railWrites,
  }).filter(c => c.name.startsWith("SET-5 "))
  for (const c of cases) it(c.name, c.run)
})

describe("SET contract: no silent skip", () => {
  const stores = () => ({ storage: new InMemoryStorage(clock), state: new InMemoryBillingState() })
  const noCheckout = () => {
    const p = new FakeSettlementProvider(webhookSecret, "fake", { capabilities: { checkout: false } })
    // Shadow the method: this rail has no checkout.
    ;(p as { createCheckout?: unknown }).createCheckout = undefined
    return p
  }
  it("a case declared unsupported passes when its capability is off", async () => {
    const p = noCheckout()
    const cases = settlementProviderContractCases({ provider: p, clock, stores, events: p.events(), unsupported: ["SET-10", "SET-12"] })
    const declared = cases.filter(c => c.name.endsWith("(declared unsupported)"))
    expect(declared.map(c => c.name.split(" ")[0])).toEqual(["SET-10", "SET-12"])
    for (const c of declared) await c.run()
  })
  it("a case declared unsupported fails when its capability is on", async () => {
    const cases = settlementProviderContractCases({ provider, clock, stores, events: provider.events(), unsupported: ["SET-21"] })
    await expect(cases.find(c => c.name.startsWith("SET-21"))!.run()).rejects.toThrow(/capability 'refundReversals' is on/)
  })
  it("a case every provider must pass cannot be declared unsupported", async () => {
    const cases = settlementProviderContractCases({ provider, clock, stores, events: provider.events(), unsupported: ["SET-1"] })
    await expect(cases.find(c => c.name.startsWith("SET-1 "))!.run()).rejects.toThrow(/every provider must pass it/)
  })
  it("a case whose scenario is missing fails, naming what is missing", async () => {
    const { refundFailed: _drop, ...events } = provider.events()
    const cases = settlementProviderContractCases({ provider, clock, stores, events })
    await expect(cases.find(c => c.name.startsWith("SET-21"))!.run()).rejects.toThrow(/events\.refundFailed/)
  })
  it("a case whose capability is off fails unless it is declared", async () => {
    const p = noCheckout()
    const cases = settlementProviderContractCases({ provider: p, clock, stores, events: p.events() })
    await expect(cases.find(c => c.name.startsWith("SET-10"))!.run()).rejects.toThrow(/list 'SET-10' in `unsupported`/)
  })
})
