---
# DRAFT example, AIP-BILLING v0.4 (billing/v1). Agentik SEO (hosted OpenSEO fork), from the Autumn configuration versioned
# in the studio (projects/agentic-verticals/packs/agentic-seo/billing/autumn.config.ts) and projects/agentic-verticals/packs/agentic-seo/briefs/UX-BILLING.md. This product has its own anchor:
# 1 000 credits = 1 USD, a field value of its own, not a derived one. State of the code on 2026-11-20: the Autumn
# configuration was pushed to the Autumn SANDBOX on 2026-09-02 and its recreation in production is listed as a to-do
# (UX-BILLING.md:144-145), so there is no confirmed production behaviour to copy; this file describes that configuration.
schema: billing/v1
name: agentik-seo
title: Agentik SEO billing
version: 0.4.0

assets:
  - { ref: aip://49/USD }
  - ref: SEO_CREDITS
    name: SEO credits
    symbol: SEOC
    decimals: 0
    standard: internal
    ruleSet: { settleOut: false, spendableOn: ["*"], convertEdges: [], transfer: none }
    partitions:
      - { id: "SEO_CREDITS:monthly", asset: SEO_CREDITS, restriction: [] }   # Autumn feature usage_credits, reset each cycle
      - { id: "SEO_CREDITS:topup",   asset: SEO_CREDITS, restriction: [] }   # Autumn feature topup_credits, never expires
primaryAsset: SEO_CREDITS
# The anchor is this product's own: 1 000 credits per USD ("1 000 credits = 1 USD billed", autumn.config.ts:29,63).
anchor: { currency: USD, creditsPerUnit: 1000 }
# The monthly allowance is spent before the top-up (autumn.config.ts:37 "consumed after the monthly allowance").
spendOrder: ["SEO_CREDITS:monthly", "SEO_CREDITS:topup"]
# No tax code was found for this product; Stripe behind Autumn sets what is added to the price. Credited whole: `gross`.
taxBasis: gross

features:
  - { id: paid_plan, type: boolean }
  - { id: managed_service_access, type: boolean }
  - { id: credits, type: credits }

accounts:
  kinds: [organization]
  hierarchy: { maxDepth: 0, funding: [] }
payer: { strategy: self, owner: [organizationId] }

conversions:
  - id: usd-to-credits
    from: USD
    to: SEO_CREDITS
    rail: autumn
    # Computed from the anchor: 1 USD = 1 000 credits; 100 cents -> 1 000 credits (decimals 0 - 2 = -2) (rule 9).
    # Top-up: prepaid, one-off, 1 USD per 1 000 credits (autumn.config.ts:64-80).
    mint: { partition: "SEO_CREDITS:topup" }
    enabled: true

offers:
  - id: credit-top-up                      # Autumn plan credit-top-up, quantity chosen by the user (autumn.config.ts:64-80)
    # No minimum and no maximum are configured: the user picks a quantity of 1 000 credits (billingUnits 1000).
    price: { model: prepaid-pool, amountMinor: buyer, currency: USD }
    convert: usd-to-credits
  - id: base-plan                          # "price to be validated" (autumn.config.ts:47)
    price: { model: subscription, amountMinor: 1900, currency: USD, interval: month }
    includes:
      - { feature: paid_plan }
      - { feature: managed_service_access }
      - { feature: credits, amountMinor: 10000, partition: "SEO_CREDITS:monthly", rollover: none }   # reset: { interval: month } (autumn.config.ts:57-58)
    # `anchor: payment`: Autumn resets at the customer's billing cycle. OPEN DECISION (grace): none configured, the
    # field is left out. `onUpgrade: none`: no proration configured.
    subscription: { anchor: payment, onUpgrade: none }
  - id: bundle-seo-augmente                # one-off 99 USD, sold through Stripe via Autumn (autumn.config.ts:97-111)
    price: { model: one-time, amountMinor: 9900, currency: USD }
    includes:
      - { feature: paid_plan }
      - { feature: managed_service_access }
      - { feature: credits, amountMinor: 15000, partition: "SEO_CREDITS:topup" }   # 15 000 credits into topup_credits

rails:
  # The bundle was first sold through Lemon Squeezy; on 2026-09-02 the product owner moved it to Stripe via Autumn
  # (UX-BILLING.md:147-153), "no more Lemon Squeezy webhook, no more pending_entitlements table". So the two-rail
  # case of the earlier draft of this example is gone: one rail. AUTUMN_SECRET_KEY, AUTUMN_WEBHOOK_SECRET, AUTUMN_MODE.
  - { id: autumn, productTag: agentik-seo }
---

# Agentik SEO

The case that tests the spec outside our other products: its own anchor (1 000 credits per dollar), credits with no
decimals, Autumn as the rail and as the projection (`toAutumnPlan` has to give back `autumn.config.ts`). Included credits
of a plan and a one-off bundle are allocations, not conversions: an offer of model `one-time` with `includes`.
