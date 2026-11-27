/**
 * The NAIVE calls, kept only as the baseline of `call-rules.ts`: the call
 * side as a first reading of the Stripe reference would write it. Not
 * shipped (test directory), not exported. It is this adapter's provider with
 * its call methods replaced, so each rule fails on the method it tests.
 *
 * What it does, on purpose: `check()` reads the key prefix only; `refund()`
 * strips the rail prefix whatever the movement, sends no idempotency key and
 * returns Stripe's message as is; `createCheckout` and `createPortalSession`
 * call Stripe at once, with the URLs and owner keys as given; `syncCatalog`
 * creates a product and a price for every offer, without reading what is
 * there, dry run or not.
 */
import type { SettlementProvider } from "@agentproto/billing"
import { toStripeCatalog } from "../catalog.js"
import { createStripeProvider, stripeKeyMode, type StripeProviderConfig } from "../provider.js"

export function createNaiveCallsProvider(cfg: StripeProviderConfig): SettlementProvider {
  const real = createStripeProvider(cfg)
  const client = cfg.client
  return {
    ...real,
    async check() {
      return cfg.secretKey && stripeKeyMode(cfg.secretKey) === cfg.mode ? { ok: true } : { ok: false, reason: "bad key" }
    },
    async refund(movement, amountMinor) {
      try {
        const r = await client.refunds.create({ payment_intent: movement.replace(/^[a-z]+:/, ""), amount: amountMinor })
        return { ok: true, externalRef: `stripe:${r.id}` }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    async createCheckout(req) {
      const metadata: Record<string, string> = { agentproto_offer: req.offerId }
      for (const k of cfg.ownerKeys) metadata[`agentproto_owner_${k}`] = req.owner[k] ?? ""
      const price = (await client.prices.list({ lookup_keys: [req.offerId], limit: 1 })).data[0]
      const s = await client.checkout.sessions.create({ mode: "payment", success_url: req.successUrl, cancel_url: req.cancelUrl, line_items: [{ price: price?.id ?? req.offerId, quantity: 1 }], metadata })
      return { outcome: "redirect", url: s.url ?? "", ref: s.id }
    },
    async createPortalSession(req) {
      return { url: (await client.billingPortal.sessions.create({ customer: req.payer?.ref ?? "", return_url: req.returnUrl })).url }
    },
    async syncCatalog(manifest) {
      const catalog = toStripeCatalog(manifest)
      const report = { created: [] as string[], updated: [] as string[], unchanged: [] as string[], degradations: catalog.degradations }
      for (const o of catalog.offers) {
        await client.products.create({ id: `${o.product.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: o.product.name, metadata: o.product.metadata })
        if (o.price) await client.prices.create({ product: o.product.id, currency: o.price.currency, unit_amount: o.price.unitAmount, lookup_key: o.price.lookupKey, transfer_lookup_key: true, metadata: o.price.metadata })
        report.created.push(o.offerId)
      }
      return report
    },
  }
}
