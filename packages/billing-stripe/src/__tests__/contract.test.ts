import { settlementProviderContractCases } from "@agentproto/billing/contract-tests"
import { describe, it } from "vitest"
import { createStripeProvider } from "../provider.js"
import { makeKit, stripeEvents } from "./kit.js"
import { STRIPE_REFERENCE_MANIFEST } from "./manifest.js"

/**
 * The SET-* cases of `@agentproto/billing` against this provider. What it does
 * not serve yet is declared, with its capability off: checkout (SET-10, SET-12)
 * and catalog sync (SET-11).
 */
const UNSUPPORTED = ["SET-10", "SET-11", "SET-12"] as const

describe("SET contract (Stripe provider, in-memory stores)", () => {
  const kit = makeKit()
  const provider = createStripeProvider(kit.config())
  const cases = settlementProviderContractCases({
    provider,
    clock: kit.clock,
    stores: kit.stores,
    manifestSource: STRIPE_REFERENCE_MANIFEST,
    events: stripeEvents(kit),
    unsupported: UNSUPPORTED,
    secrets: [kit.secretKey, kit.webhookSecret],
    misconfigured: () => createStripeProvider(kit.config({ secretKey: `sk_live_${globalThis.crypto.randomUUID().replace(/-/g, "")}` })),
  })
  for (const c of cases) it(c.name, c.run)
})

describe("SET contract (Stripe provider, live mode)", () => {
  const kit = makeKit({ mode: "live" })
  const provider = createStripeProvider(kit.config())
  const cases = settlementProviderContractCases({
    provider,
    clock: kit.clock,
    stores: kit.stores,
    manifestSource: STRIPE_REFERENCE_MANIFEST,
    events: stripeEvents(kit),
    unsupported: UNSUPPORTED,
    secrets: [kit.secretKey, kit.webhookSecret],
    misconfigured: () => createStripeProvider(kit.config({ secretKey: `rk_test_${globalThis.crypto.randomUUID().replace(/-/g, "")}` })),
  }).filter(c => /^SET-(1|3|8|9) /.test(c.name))
  for (const c of cases) it(c.name, c.run)
})
