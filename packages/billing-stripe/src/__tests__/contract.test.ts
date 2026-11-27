import { settlementProviderContractCases } from "@agentproto/billing/contract-tests"
import { describe, expect, it } from "vitest"
import { toStripeCatalog } from "../catalog.js"
import { createStripeProvider } from "../provider.js"
import { SHOP_ORIGIN, makeKit, stripeEvents, type Kit } from "./kit.js"
import { STRIPE_REFERENCE_MANIFEST } from "./manifest.js"

/**
 * The SET-* cases of `@agentproto/billing` against this provider. Nothing is
 * declared unsupported: every capability a case needs is on.
 */
const UNSUPPORTED: readonly string[] = []

function contract(kit: Kit) {
  const provider = createStripeProvider(kit.config())
  // SET-10 checks out `pack-20` before SET-11 syncs the catalog: its price is already at the rail.
  kit.client.seed(toStripeCatalog(kit.manifest), ["pack-20"])
  return settlementProviderContractCases({
    provider,
    clock: kit.clock,
    stores: kit.stores,
    manifestSource: STRIPE_REFERENCE_MANIFEST,
    events: stripeEvents(kit),
    unsupported: UNSUPPORTED,
    secrets: [kit.secretKey, kit.webhookSecret],
    returnUrls: { allowed: `${SHOP_ORIGIN}/billing/done`, refused: "https://shop.example.com.evil.example/done" },
    railWrites: () => kit.client.writes,
    misconfigured: () => createStripeProvider(kit.config({ secretKey: `sk_${kit.mode === "live" ? "test" : "live"}_${globalThis.crypto.randomUUID().replace(/-/g, "")}` })),
  })
}

describe("SET contract (Stripe provider, in-memory stores)", () => {
  const cases = contract(makeKit())
  it("plays every case, none declared unsupported", () => {
    expect(UNSUPPORTED).toEqual([])
    expect(cases.map(c => c.name.split(" ")[0])).toEqual(["SET-1", "SET-2", "SET-3", "SET-5", "SET-5-SUB", "SET-6", "SET-7", "SET-8", "SET-9", "SET-10", "SET-11", "SET-12", "SET-13", "SET-21", "SET-22"])
  })
  for (const c of cases) it(c.name, c.run)
})

describe("SET contract (Stripe provider, live mode)", () => {
  const cases = contract(makeKit({ mode: "live" })).filter(c => /^SET-(1|3|8|9|10|12) /.test(c.name))
  for (const c of cases) it(c.name, c.run)
})
