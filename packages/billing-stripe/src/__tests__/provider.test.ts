import { makeBillingRegistry, type PaymentFact } from "@agentproto/billing"
import Stripe from "stripe"
import { describe, expect, it } from "vitest"
import { STRIPE_API_VERSION } from "../api-version.js"
import type { StripeLike } from "../client.js"
import { STRIPE_CAPABILITIES, createProvider, createStripeProvider, stripeKeyMode } from "../provider.js"
import { eventOf, makeKit } from "./kit.js"

// Type test: the real SDK satisfies the structural client (compile time, `check-types`).
export const sdkIsStripeLike = (s: Stripe): StripeLike => s
// Type test: the constant is the SDK's pinned version.
const pinned: Stripe.LatestApiVersion = STRIPE_API_VERSION
void pinned

function setup(over: Parameters<ReturnType<typeof makeKit>["config"]>[0] = {}) {
  const kit = makeKit()
  const provider = createStripeProvider(kit.config(over))
  const verify = (e: ReturnType<typeof eventOf>) => provider.verifyWebhook(kit.sign(e))
  return { kit, provider, verify }
}

describe("API version", () => {
  it("equals the version the installed SDK pins, and is basil or later", () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION)
    expect(STRIPE_API_VERSION.slice(0, 10) >= "2025-03-31").toBe(true)
  })
  it("an event of another version, or without one, throws", async () => {
    const { verify } = setup()
    await expect(verify(eventOf("checkout.session.completed", { api_version: "2025-03-31.basil" }))).rejects.toThrow(/API version '2025-03-31.basil'/)
    await expect(verify(eventOf("checkout.session.completed", { api_version: null }))).rejects.toThrow(/API version/)
  })
})

describe("construction and capabilities", () => {
  it("onUnhandled, client and ownerKeys are required", () => {
    const kit = makeKit()
    expect(() => createStripeProvider({ ...kit.config(), onUnhandled: undefined as never })).toThrow(/onUnhandled/)
    expect(() => createStripeProvider({ ...kit.config(), client: undefined as never })).toThrow(/client/)
    expect(() => createStripeProvider({ ...kit.config(), ownerKeys: [] })).toThrow(/ownerKeys/)
  })
  it("declares no refund, checkout, portal, catalog sync nor off-session charge, and has none of those methods", async () => {
    const { provider } = setup()
    expect(provider.capabilities).toEqual(STRIPE_CAPABILITIES)
    expect(provider.capabilities.refunds).toBe("none")
    expect(provider.refund).toBeUndefined()
    expect(provider.createCheckout).toBeUndefined()
    expect(provider.createPortalSession).toBeUndefined()
    expect(provider.syncCatalog).toBeUndefined()
    expect(await provider.charge({ accountId: "acme", amountMinor: 100, asset: "EUR", ref: "r" })).toEqual({ ok: false, error: "unsupported" })
    expect(await provider.pay({ counterparty: "acme", amountMinor: 100, asset: "EUR" })).toEqual({ ok: false, error: "unsupported" })
  })
  it("check(): a key present, of a known kind and of the rail's mode", async () => {
    const kit = makeKit()
    expect(await createStripeProvider(kit.config()).check!()).toEqual({ ok: true })
    expect((await createStripeProvider(kit.config({ secretKey: undefined })).check!()).reason).toMatch(/STRIPE_SECRET_KEY is not set/)
    expect((await createStripeProvider(kit.config({ webhookSecret: undefined })).check!()).reason).toMatch(/STRIPE_WEBHOOK_SECRET is not set/)
    expect((await createStripeProvider(kit.config({ webhookSecret: "" })).check!()).ok).toBe(false)
    expect((await createStripeProvider(kit.config({ secretKey: "pk_test_abc" })).check!()).reason).toMatch(/not a secret or restricted key/)
    expect((await createStripeProvider(kit.config({ secretKey: "sk_live_abc" })).check!()).reason).toMatch(/test mode but its key is a live key/)
    expect([stripeKeyMode("sk_test_x"), stripeKeyMode("rk_test_x"), stripeKeyMode("sk_live_x"), stripeKeyMode("rk_live_x"), stripeKeyMode("whsec_x")]).toEqual(["test", "test", "live", "live", null])
  })
  it("createProvider reads the variables from env and the rest from options; the registry builds it", async () => {
    const kit = makeKit()
    const opts = kit.config()
    const env = { STRIPE_SECRET_KEY: kit.secretKey, STRIPE_WEBHOOK_SECRET: kit.webhookSecret, STRIPE_MODE: "test" }
    const p = createProvider({ env, providers: async () => null, options: { client: opts.client, ownerKeys: opts.ownerKeys, onUnhandled: opts.onUnhandled, now: opts.now } })
    expect(await p.check!()).toEqual({ ok: true })
    expect(await p.verifyWebhook(kit.sign(eventOf("customer.updated")))).toBeNull()
    expect(() => createProvider({ env, providers: async () => null })).toThrow(/onUnhandled/)
    const reg = makeBillingRegistry({
      env,
      importPackage: async name => (name === "@agentproto/billing-stripe" ? { createProvider } : {}),
      providerOptions: { stripe: { client: opts.client, ownerKeys: ["orgId"], onUnhandled: opts.onUnhandled } },
    })
    const resolved = await reg.provider("stripe")
    expect(resolved?.id).toBe("stripe")
    expect(JSON.stringify(await reg.family.list())).not.toContain(kit.secretKey)
  })
})

describe("signature", () => {
  it("reads the header whatever the case of its name, or as an array", async () => {
    const { kit, provider } = setup()
    const req = kit.sign(eventOf("customer.updated"))
    const value = req.headers["stripe-signature"]
    await expect(provider.verifyWebhook({ body: req.body, headers: { "STRIPE-SIGNATURE": value } })).resolves.toBeNull()
    await expect(provider.verifyWebhook({ body: req.body, headers: { "stripe-signature": [value] as never } })).resolves.toBeNull()
  })
  it("refuses a header without timestamp or without v1, and a valid signature on a body that is not an event", async () => {
    const { kit, provider } = setup()
    const req = kit.sign(eventOf("customer.updated"))
    const v1 = req.headers["stripe-signature"].split(",")[1]!
    await expect(provider.verifyWebhook({ body: req.body, headers: { "stripe-signature": v1 } })).rejects.toThrow(/timestamp/)
    await expect(provider.verifyWebhook({ body: req.body, headers: { "stripe-signature": `t=${kit.seconds()}` } })).rejects.toThrow(/no v1/)
    await expect(provider.verifyWebhook(kit.sign({ hello: "world" } as never))).rejects.toThrow(/not a Stripe event/)
  })
  it("refuses a timestamp too far in the future as well", async () => {
    const { kit, provider } = setup()
    const req = kit.sign(eventOf("customer.updated"))
    kit.clock.advance(-301_000)
    await expect(provider.verifyWebhook(req)).rejects.toThrow(/tolerance 300s/)
  })
})

describe("events that give no fact", () => {
  const nulls: [string, Parameters<typeof eventOf>[1]][] = [
    ["payment_intent.succeeded", {}],
    ["charge.succeeded", {}],
    ["invoice.payment_succeeded", {}],
    ["invoice_payment.paid", {}],
    ["charge.refunded", {}],
    ["customer.updated", {}],
    ["checkout.session.completed", { object: { mode: "subscription", subscription: "sub_1Ex0Subscription0001", invoice: "in_1Ex0Invoice0001" } }],
    ["checkout.session.completed", { type: "checkout.session.async_payment_failed", object: { payment_status: "unpaid" } }],
    ["customer.subscription.deleted", { type: "customer.subscription.updated", object: { status: "active", cancel_at_period_end: true, ended_at: null } }],
    ["refund.updated", { type: "charge.refund.updated" }],
    ["invoice.paid", { object: { parent: null } }],
  ]
  for (const [name, patch] of nulls) {
    it(`${patch?.type ?? name}${patch?.object ? ` (${Object.keys(patch.object).join(", ")})` : ""}`, async () => {
      const { kit, verify } = setup()
      expect(await verify(eventOf(name, patch))).toBeNull()
      expect(kit.unhandled).toEqual([])
      expect(kit.client.calls).toBe(0)
    })
  }
})

describe("payments", () => {
  it("checkout: movement of the payment intent, offer and owner from the metadata, currency upper case", async () => {
    const { verify } = setup()
    expect(await verify(eventOf("checkout.session.completed"))).toEqual({
      type: "payment",
      movement: "stripe:pi_3Ex0Intent0001",
      rail: "stripe",
      offerId: "pack-20",
      owner: { orgId: "acme" },
      amountMinor: 2000,
      taxMinor: 0,
      taxBehavior: "inclusive",
      currency: "EUR",
      paidAt: 1795694400_000,
    } satisfies PaymentFact)
  })
  it("checkout that needed no payment (a full discount): movement of the session", async () => {
    const { verify } = setup()
    const f = (await verify(eventOf("checkout.session.completed", { object: { payment_status: "no_payment_required", payment_intent: null, amount_total: 0, total_details: { amount_discount: 2000, amount_shipping: 0, amount_tax: 0 } } }))) as PaymentFact
    expect([f.movement, f.amountMinor, f.discountMinor]).toEqual(["stripe:cs_test_a1Ex0Session0001", 0, 2000])
  })
  it("checkout whose total holds another charge (shipping): no fact, onUnhandled", async () => {
    const { kit, verify } = setup()
    expect(await verify(eventOf("checkout.session.completed", { object: { amount_total: 2500, total_details: { amount_discount: 0, amount_shipping: 500, amount_tax: 0 } } }))).toBeNull()
    expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(/neither subtotal/)])
  })
  it("an owner key missing from the metadata: the fact, and onUnhandled", async () => {
    const { kit, verify } = setup({ ownerKeys: ["orgId", "userId"] })
    const f = (await verify(eventOf("checkout.session.completed"))) as PaymentFact
    expect(f.owner).toEqual({ orgId: "acme" })
    expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(/'agentproto_owner_userId' missing/)])
  })
  it("subscription invoice: one paid payment intent equal to amount_paid gives its movement; the tax and discounts are summed", async () => {
    const { kit, verify } = setup()
    kit.client.setPayments("in_1Ex0Invoice0001", [{ paymentIntent: "pi_3Ex0Intent0002", amountPaid: 400 }])
    const inv = eventOf("invoice.paid", {
      object: {
        amount_paid: 400,
        total_taxes: [
          { amount: 30, tax_behavior: "inclusive", type: "tax_rate_details" },
          { amount: 10, tax_behavior: "inclusive", type: "tax_rate_details" },
        ],
        total_discount_amounts: [{ amount: 60, discount: "di_1" }, { amount: 40, discount: "di_2" }],
      },
    })
    const f = (await verify(inv)) as PaymentFact
    expect([f.movement, f.offerId, f.amountMinor, f.taxMinor, f.taxBehavior, f.discountMinor]).toEqual(["stripe:pi_3Ex0Intent0002", "plan-month", 400, 40, "inclusive", 100])
    expect(kit.client.calls).toBe(1)
  })
  it("subscription invoice with both inclusive and exclusive taxes: no fact, onUnhandled", async () => {
    const { kit, verify } = setup()
    const inv = eventOf("invoice.paid", { object: { total_taxes: [{ amount: 30, tax_behavior: "inclusive" }, { amount: 10, tax_behavior: "exclusive" }] } })
    expect(await verify(inv)).toBeNull()
    expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(/both inclusive and exclusive/)])
  })
  const unsupported: [string, { paymentIntent: string; amountPaid: number; type?: string }[], RegExp][] = [
    ["no paid payment", [], /without a paid payment/],
    ["a payment that is not a payment intent", [{ paymentIntent: "", amountPaid: 500, type: "payment_record" }], /'payment_record' payment/],
    ["a payment of another amount", [{ paymentIntent: "pi_x", amountPaid: 450 }], /payment of 450 for an amount paid of 500/],
    ["more payments than one page", Array.from({ length: 11 }, (_, i) => ({ paymentIntent: `pi_${i}`, amountPaid: 50 })), /more than 10 payments/],
  ]
  for (const [what, items, reason] of unsupported) {
    it(`subscription invoice with ${what}: an unsupported fact under the invoice, and onUnhandled`, async () => {
      const { kit, verify } = setup()
      kit.client.setPayments("in_1Ex0Invoice0001", items)
      const f = (await verify(eventOf("invoice.paid"))) as PaymentFact
      expect([f.movement, f.amountMinor]).toEqual(["stripe:in_1Ex0Invoice0001", 500])
      expect(f.unsupported).toMatch(reason)
      expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(reason)])
    })
  }
})

describe("refunds, disputes, subscriptions", () => {
  it("a refund without payment_intent: no fact, onUnhandled", async () => {
    const { kit, verify } = setup()
    expect(await verify(eventOf("refund.updated", { object: { payment_intent: null } }))).toBeNull()
    expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(/without payment_intent/)])
  })
  it("refund statuses: succeeded gives a refund, failed and canceled a reversal, pending and requires_action nothing", async () => {
    const { verify } = setup()
    const typeAt = async (status: string) => (await verify(eventOf("refund.updated", { object: { status } })))?.type ?? null
    expect(await Promise.all(["succeeded", "failed", "canceled", "pending", "requires_action"].map(typeAt))).toEqual(["refund", "refund_reversed", "refund_reversed", null, null])
    expect(await verify(eventOf("refund.updated", { object: { payment_intent: { id: "pi_expanded" } } }))).toMatchObject({ paymentMovement: "stripe:pi_expanded", movement: "stripe:re_3Ex0Refund0001", amountMinor: 1000 })
  })
  it("one rule on the dispute status, whatever the event type", async () => {
    const { kit, verify } = setup()
    const table: Record<string, string | null> = {
      warning_needs_response: null,
      warning_under_review: null,
      warning_closed: null,
      needs_response: "opened",
      under_review: "opened",
      appeal_needs_response: "opened",
      appeal_under_review: "opened",
      won: "won",
      prevented: "won",
      lost: "lost",
    }
    for (const type of ["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"]) {
      for (const [status, want] of Object.entries(table)) {
        const f = await verify(eventOf("charge.dispute.created", { type, object: { status } }))
        expect([type, status, f?.type === "dispute" ? f.status : null]).toEqual([type, status, want])
      }
    }
    expect(kit.unhandled).toEqual([])
    expect(await verify(eventOf("charge.dispute.created", { object: { status: "some_new_status" } }))).toBeNull()
    expect(kit.unhandled.map(u => u.reason)).toEqual([expect.stringMatching(/unknown status 'some_new_status'/)])
    expect(await verify(eventOf("charge.dispute.created"))).toMatchObject({ movement: "stripe:dp_1Ex0Dispute0001", paymentMovement: "stripe:pi_3Ex0Intent0001", amountMinor: 2000, currency: "EUR" })
  })
  it("invoice.payment_failed of a subscription: renewal_failed under the invoice", async () => {
    const { verify } = setup()
    expect(await verify(eventOf("invoice.payment_failed"))).toEqual({ type: "renewal_failed", movement: "stripe:in_1Ex0Invoice0001", rail: "stripe", offerId: "plan-month", owner: { orgId: "acme" }, at: 1795694400_000 })
  })
  it("customer.subscription.deleted: subscription_ended at ended_at; payment_failed reads as unpaid", async () => {
    const { verify } = setup()
    expect(await verify(eventOf("customer.subscription.deleted"))).toEqual({ type: "subscription_ended", movement: "stripe:sub_1Ex0Subscription0001", rail: "stripe", offerId: "plan-month", owner: { orgId: "acme" }, reason: "canceled", at: 1798372800_000 })
    expect(await verify(eventOf("customer.subscription.deleted", { object: { cancellation_details: { reason: "payment_failed" } } }))).toMatchObject({ reason: "unpaid" })
  })
  it("offerNamespace also scopes the subscription facts", async () => {
    const { verify } = setup({ offerNamespace: "shop-b/" })
    expect(await verify(eventOf("invoice.payment_failed"))).toBeNull()
    expect(await verify(eventOf("customer.subscription.deleted"))).toBeNull()
    expect(await verify(eventOf("checkout.session.completed", { object: { metadata: { agentproto_offer: "shop-b/pack-20" } } }))).toMatchObject({ offerId: "shop-b/pack-20" })
  })
})
