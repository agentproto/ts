import { loadBillingManifest } from "@agentproto/billing/manifest"
import { describe, expect, it } from "vitest"
import { safeStripeError } from "../calls.js"
import { applyStripeCatalog, toStripeCatalog, trialDaysOf } from "../catalog.js"
import { createStripeProvider } from "../provider.js"
import { CALL_RULES } from "./call-rules.js"
import { SHOP_ORIGIN, makeKit } from "./kit.js"
import { STRIPE_REFERENCE_MANIFEST } from "./manifest.js"
import { createNaiveCallsProvider } from "./naive-calls.js"

describe("call rules (this adapter)", () => {
  for (const r of CALL_RULES) it(`${r.id} ${r.title}`, () => r.run(createStripeProvider))
})

// Each rule must fail against the naive calls.
describe("call rules (naive calls)", () => {
  for (const r of CALL_RULES) {
    it(`${r.id} fails on the naive calls`, async () => {
      let failure: Error | null = null
      try {
        await r.run(createNaiveCallsProvider)
      } catch (e) {
        failure = e as Error
      }
      expect(failure, `${r.id} passed on the naive calls`).not.toBeNull()
      if (process.env.PRINT_NAIVE_FAILURES) console.log(`NAIVE ${r.id}: ${failure!.message.split("\n")[0]}`)
    })
  }
})

const ok = `${SHOP_ORIGIN}/billing/done`

function setup(over: Parameters<ReturnType<typeof makeKit>["config"]>[0] = {}) {
  const kit = makeKit()
  const provider = createStripeProvider(kit.config(over))
  kit.client.seed(toStripeCatalog(kit.manifest))
  return { kit, provider, client: kit.client }
}

describe("toStripeCatalog", () => {
  const m = loadBillingManifest(STRIPE_REFERENCE_MANIFEST, { strategies: [] })
  it("one product per offer under a stable id; a price by lookup key for a fixed amount; none for a buyer amount", () => {
    const c = toStripeCatalog(m)
    expect(c.rail).toBe("stripe")
    expect(c.offers.map(o => o.offerId)).toEqual(["pack-20", "pack-usd", "top-up", "plan-month", "plan-year", "plan-keep", "pack-promo", "plan-trial", "bundle"])
    const pack = c.offers.find(o => o.offerId === "pack-20")!
    expect(pack).toMatchObject({ mode: "payment", product: { id: "ap_reference_pack-20", metadata: { agentproto_offer: "pack-20", agentproto_product: "reference" } }, price: { lookupKey: "reference:pack-20", currency: "eur", unitAmount: 2000 } })
    expect(pack.price!.recurring).toBeUndefined()
    expect(c.offers.find(o => o.offerId === "plan-year")).toMatchObject({ mode: "subscription", price: { recurring: { interval: "year", interval_count: 1 } } })
    const topUp = c.offers.find(o => o.offerId === "top-up")!
    expect([topUp.price, topUp.buyer]).toEqual([undefined, { currency: "eur", minMinor: 1000, maxMinor: 100000 }])
    expect(c.offers.find(o => o.offerId === "plan-trial")!.trialDays).toBe(14)
    expect(c.offers.find(o => o.offerId === "pack-promo")!.allowPromotionCodes).toBe(true)
    expect(c.offers.find(o => o.offerId === "pack-20")!.allowPromotionCodes).toBe(false)
  })
  it("names every degradation: included credits, rollover, bonus", () => {
    const d = toStripeCatalog(m).degradations
    expect(d.filter(x => x.field === "conversion.bonus").map(x => x.offerId)).toEqual(["pack-20", "top-up", "pack-promo"])
    expect(d.filter(x => x.field === "includes").map(x => x.offerId)).toEqual(["plan-month", "plan-year", "plan-keep", "plan-trial", "bundle"])
    expect(d.filter(x => x.field === "includes.rollover").map(x => x.offerId)).toEqual(["plan-keep"])
  })
  it("calendar anchor, proration, a trial that is not whole days, an interval past three years: named", () => {
    const src = STRIPE_REFERENCE_MANIFEST.replace(
      "subscription: { anchor: payment, grace: P7D, onUpgrade: none, trial: P14D }",
      "subscription: { anchor: calendar, grace: P7D, onUpgrade: prorate, trial: P1M }",
    ).replace("  - id: bundle\n", "  - { id: plan-long, price: { model: subscription, amountMinor: 100, currency: EUR, interval: month, intervalCount: 40 }, includes: [ { feature: pro } ], subscription: { anchor: payment, onUpgrade: none } }\n  - id: bundle\n")
    const c = toStripeCatalog(loadBillingManifest(src, { strategies: [] }))
    const of = (id: string) => c.degradations.filter(x => x.offerId === id).map(x => x.field)
    expect(of("plan-trial")).toEqual(["includes", "subscription.anchor", "subscription.onUpgrade", "subscription.trial"])
    expect(c.offers.find(o => o.offerId === "plan-trial")!.trialProblem).toMatch(/months or years/)
    expect(of("plan-long")).toEqual(["price.intervalCount"])
    expect(c.offers.map(o => o.offerId)).not.toContain("plan-long")
  })
  it("a vendor price model is not sold on Stripe, and named", () => {
    const src = STRIPE_REFERENCE_MANIFEST.replace("  - id: bundle\n", "  - { id: vendor, price: { model: 'x-acme:meter' } }\n  - id: bundle\n")
    const c = toStripeCatalog(loadBillingManifest(src, { strategies: ["x-acme:meter"] }))
    expect(c.degradations.filter(x => x.offerId === "vendor").map(x => x.field)).toEqual(["price.model"])
    expect(c.offers.map(o => o.offerId)).not.toContain("vendor")
  })
  it("rail.stripe.lookupKey keeps an existing key; offerNamespace leaves the other offers out", () => {
    const src = STRIPE_REFERENCE_MANIFEST.replace("  - { id: pack-usd, price: { model: prepaid-pool, amountMinor: 1000, currency: USD }, convert: usd-to-credits }", "  - { id: pack-usd, price: { model: prepaid-pool, amountMinor: 1000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: legacy_usd_pack } } }")
    const mm = loadBillingManifest(src, { strategies: [] })
    expect(toStripeCatalog(mm).offers.find(o => o.offerId === "pack-usd")!.price!.lookupKey).toBe("legacy_usd_pack")
    const ns = toStripeCatalog(mm, { offerNamespace: "plan-" })
    expect(ns.offers.map(o => o.offerId)).toEqual(["plan-month", "plan-year", "plan-keep", "plan-trial"])
    expect(ns.degradations.filter(x => x.field === "id").length).toBe(5)
  })
  it("is pure: the manifest is not mutated and two runs are equal", () => {
    const before = JSON.stringify([...m.derived.offers.values()])
    expect(JSON.stringify(toStripeCatalog(m))).toBe(JSON.stringify(toStripeCatalog(m)))
    expect(JSON.stringify([...m.derived.offers.values()])).toBe(before)
  })
  it("trialDaysOf: days and weeks; months, years, hours and zero are not carried", () => {
    expect([trialDaysOf("P14D"), trialDaysOf("P2W"), trialDaysOf("P1W3D"), trialDaysOf("P730D")]).toEqual([{ days: 14 }, { days: 14 }, { days: 10 }, { days: 730 }])
    for (const d of ["P1M", "P1Y", "PT36H", "P1DT12H", "P0D", "P731D", "P"]) expect(trialDaysOf(d)).toHaveProperty("problem")
  })
})

describe("syncCatalog", () => {
  it("a changed price: a new price takes the lookup key over; the old one is kept, nothing is deleted", async () => {
    const kit = makeKit()
    const provider = createStripeProvider(kit.config())
    await provider.syncCatalog!(kit.manifest)
    const old = [...kit.client.pricesById.values()].find(p => p.lookup_key === "reference:pack-20")!
    const raised = loadBillingManifest(STRIPE_REFERENCE_MANIFEST.replace("{ id: pack-20, price: { model: prepaid-pool, amountMinor: 2000", "{ id: pack-20, price: { model: prepaid-pool, amountMinor: 2500"), { strategies: [] })
    const report = await provider.syncCatalog!(raised)
    expect(report.updated).toEqual(["pack-20"])
    expect(report.created).toEqual([])
    const now = [...kit.client.pricesById.values()].find(p => p.lookup_key === "reference:pack-20")!
    expect([now.unit_amount, now.id === old.id]).toEqual([2500, false])
    expect(kit.client.pricesById.get(old.id)).toMatchObject({ active: true, lookup_key: null, unit_amount: 2000 })
    const created = kit.client.log.filter(c => c.method === "prices.create").at(-1)!
    expect(created.params).toMatchObject({ transfer_lookup_key: true, lookup_key: "reference:pack-20" })
    expect(created.options?.idempotencyKey).toMatch(/^agentproto-catalog-price-[0-9a-f]{32}$/)
    expect(kit.client.log.map(c => c.method).filter(m => !/\.(list|create|update|retrieveCurrent)$/.test(m))).toEqual([])
  })
  it("an archived product is reactivated, not recreated", async () => {
    const kit = makeKit()
    const provider = createStripeProvider(kit.config())
    await provider.syncCatalog!(kit.manifest)
    kit.client.productsById.get("ap_reference_bundle")!.active = false
    const r = await provider.syncCatalog!(kit.manifest)
    expect(r.updated).toEqual(["bundle"])
    expect(kit.client.productsById.get("ap_reference_bundle")!.active).toBe(true)
  })
  it("reads the prices ten lookup keys at a time (20 fixed prices: two reads)", async () => {
    const kit = makeKit()
    const many = STRIPE_REFERENCE_MANIFEST.replace("  - id: bundle\n", Array.from({ length: 12 }, (_, i) => `  - { id: extra-${i}, price: { model: one-time, amountMinor: ${100 + i}, currency: EUR } }\n`).join("") + "  - id: bundle\n")
    const report = await applyStripeCatalog(kit.client, toStripeCatalog(loadBillingManifest(many, { strategies: [] })), { dryRun: true })
    expect(report.created.length).toBe(21)
    expect(kit.client.log.filter(c => c.method === "prices.list").map(c => (c.params as { lookup_keys: string[] }).lookup_keys.length)).toEqual([10, 10])
  })
})

describe("createCheckout", () => {
  it("one-time: the price found by lookup key, the metadata, the account as client_reference_id, a redirect", async () => {
    const { provider, client } = setup()
    const out = await provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok, payer: { email: "buyer@example.com" } })
    expect(out).toMatchObject({ outcome: "redirect", url: expect.stringMatching(/^https:\/\/checkout\.example\.com\//) })
    const s = client.sessions.get(out.ref)!
    const price = [...client.pricesById.values()].find(p => p.lookup_key === "reference:pack-20")!
    expect(s).toEqual({ mode: "payment", success_url: ok, cancel_url: ok, line_items: [{ price: price.id, quantity: 1 }], metadata: { agentproto_offer: "pack-20", agentproto_owner_orgId: "acme" }, client_reference_id: "acme", customer_email: "buyer@example.com" })
  })
  it("subscription with a trial: subscription_data carries the metadata and the trial days; a customer ref is passed", async () => {
    const { provider, client } = setup()
    const out = await provider.createCheckout!({ offerId: "plan-trial", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok, payer: { ref: "cus_1Ex0Customer0001", email: "ignored@example.com" } })
    const s = client.sessions.get(out.ref)!
    expect(s.mode).toBe("subscription")
    expect(s.customer).toBe("cus_1Ex0Customer0001")
    expect(s.customer_email).toBeUndefined()
    expect(s.subscription_data).toEqual({ metadata: { agentproto_offer: "plan-trial", agentproto_owner_orgId: "acme" }, trial_period_days: 14 })
  })
  it("promotion codes only on an offer that allows discounts; automatic tax when asked", async () => {
    const { provider, client } = setup()
    const promo = client.sessions.get((await provider.createCheckout!({ offerId: "pack-promo", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok })).ref)!
    const plain = client.sessions.get((await provider.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok })).ref)!
    expect([promo.allow_promotion_codes, plain.allow_promotion_codes]).toEqual([true, undefined])
    const taxed = makeKit()
    const tp = createStripeProvider(taxed.config({ automaticTax: { taxBehavior: "exclusive" } }))
    taxed.client.seed(toStripeCatalog(taxed.manifest, { taxBehavior: "exclusive" }))
    const s = taxed.client.sessions.get((await tp.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok })).ref)!
    expect(s.automatic_tax).toEqual({ enabled: true })
  })
  it("a buyer amount: price_data within the offer's bounds, checked before any call", async () => {
    const { provider, client } = setup()
    for (const amountMinor of [undefined, 999, 100001, 1500.5]) {
      await expect(provider.createCheckout!({ offerId: "top-up", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok, ...(amountMinor !== undefined ? { amountMinor } : {}) })).rejects.toThrow()
    }
    await expect(provider.createCheckout!({ offerId: "top-up", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok, amountMinor: 1500, currency: "USD" })).rejects.toThrow(/currency/)
    expect(client.log).toEqual([])
    const out = await provider.createCheckout!({ offerId: "top-up", owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok, amountMinor: 1500, currency: "eur" })
    expect(client.sessions.get(out.ref)!.line_items).toEqual([{ quantity: 1, price_data: { currency: "eur", unit_amount: 1500, product_data: { name: "top-up", metadata: { agentproto_offer: "top-up", agentproto_product: "reference" } } } }])
  })
  it("refused before any call: an unknown offer, a quantity, another amount on a fixed price, a trial Stripe cannot carry, an offer outside the namespace", async () => {
    const { provider, client } = setup()
    const base = { owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok }
    await expect(provider.createCheckout!({ ...base, offerId: "nope" })).rejects.toThrow(/not sold/)
    await expect(provider.createCheckout!({ ...base, offerId: "pack-20", quantity: 2 })).rejects.toThrow(/quantity/)
    await expect(provider.createCheckout!({ ...base, offerId: "pack-20", amountMinor: 100 })).rejects.toThrow(/fixed price/)
    const ns = makeKit()
    await expect(createStripeProvider(ns.config({ offerNamespace: "plan-" })).createCheckout!({ ...base, offerId: "pack-20" })).rejects.toThrow(/offerNamespace/)
    const monthTrial = makeKit()
    const src = STRIPE_REFERENCE_MANIFEST.replace("onUpgrade: none, trial: P14D", "onUpgrade: none, trial: P1M")
    await expect(createStripeProvider(monthTrial.config({ manifest: loadBillingManifest(src, { strategies: [] }) })).createCheckout!({ ...base, offerId: "plan-trial" })).rejects.toThrow(/trial/)
    expect([client.log, ns.client.log, monthTrial.client.log]).toEqual([[], [], []])
  })
  it("a price missing at Stripe, or that differs from the manifest: refused, nothing written", async () => {
    const kit = makeKit()
    const provider = createStripeProvider(kit.config())
    const base = { owner: { orgId: "acme" }, accountId: "acme", successUrl: ok, cancelUrl: ok }
    await expect(provider.createCheckout!({ ...base, offerId: "pack-20" })).rejects.toThrow(/run syncCatalog/)
    kit.client.seed(toStripeCatalog(kit.manifest), ["pack-20"])
    ;[...kit.client.pricesById.values()][0]!.unit_amount = 1999
    await expect(provider.createCheckout!({ ...base, offerId: "pack-20" })).rejects.toThrow(/differs from the manifest/)
    expect(kit.client.writes).toBe(0)
  })
})

describe("createPortalSession", () => {
  it("needs the customer id, and passes the checked return URL", async () => {
    const { provider, client } = setup()
    await expect(provider.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: ok })).rejects.toThrow(/payer.ref/)
    expect(client.log).toEqual([])
    const r = await provider.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: ok, payer: { ref: "cus_1Ex0Customer0001" } })
    expect(r.url).toMatch(/^https:\/\/billing\.example\.com\//)
    expect(client.log.map(c => [c.method, c.params])).toEqual([["billingPortal.sessions.create", { customer: "cus_1Ex0Customer0001", return_url: ok }]])
  })
})

describe("refund", () => {
  it("refunds.create with the payment intent, the amount, the ref in metadata; the movement of the refund back", async () => {
    const { provider, client } = setup()
    const r = await provider.refund!("stripe:pi_3Ex0Intent0001", 700, "refund-1")
    expect(r).toEqual({ ok: true, externalRef: expect.stringMatching(/^stripe:re_/), network: "stripe" })
    expect(client.log.at(-1)).toEqual({ method: "refunds.create", kind: "write", params: { payment_intent: "pi_3Ex0Intent0001", amount: 700, metadata: { agentproto_ref: "refund-1" } }, options: { idempotencyKey: "refund-1" } })
  })
  it("refused without a call: a zero, negative or fractional amount, an empty ref", async () => {
    const { provider, client } = setup()
    for (const [amount, ref] of [[0, "r"], [-5, "r"], [1.5, "r"], [100, ""]] as const) expect((await provider.refund!("stripe:pi_3Ex0Intent0001", amount, ref)).ok).toBe(false)
    expect(client.log).toEqual([])
  })
  it("safeStripeError masks the given secrets and anything shaped like a key", () => {
    const text = safeStripeError(Object.assign(new Error("key sk_live_abcdefgh12345678 and whsec_abcdef and rk_test_***1234 and mine-secret-value"), { type: "StripeAuthenticationError" }), ["mine-secret-value"])
    expect(text).toBe("StripeAuthenticationError: key [redacted key] and [redacted secret] and [redacted key] and [redacted]")
  })
})

describe("construction", () => {
  it("manifest, allowedReturnOrigins and every client method are required; owner keys fit Stripe metadata keys", () => {
    const kit = makeKit()
    expect(() => createStripeProvider({ ...kit.config(), manifest: undefined as never })).toThrow(/manifest/)
    expect(() => createStripeProvider({ ...kit.config(), allowedReturnOrigins: [] })).toThrow(/allowedReturnOrigins/)
    expect(() => createStripeProvider({ ...kit.config(), client: { invoicePayments: kit.client.invoicePayments } as never })).toThrow(/lacks accounts.retrieveCurrent, refunds.create/)
    expect(() => createStripeProvider({ ...kit.config(), ownerKeys: ["a".repeat(24)] })).toThrow(/1 to 23 characters/)
    expect(() => createStripeProvider({ ...kit.config(), manifest: loadBillingManifest(STRIPE_REFERENCE_MANIFEST.replace("- { id: stripe, productTag: reference }", "- { id: paddle, productTag: reference }").replaceAll("rail: stripe", "rail: paddle"), { strategies: [] }) })).toThrow(/no rail served by the 'stripe' provider/)
  })
  it("check() makes no call without expectAccount for the mode", async () => {
    const kit = makeKit()
    expect(await createStripeProvider(kit.config({ expectAccount: { live: "acct_1Ex0Live0001" } })).check!()).toEqual({ ok: true })
    expect(kit.client.log).toEqual([])
  })
})
