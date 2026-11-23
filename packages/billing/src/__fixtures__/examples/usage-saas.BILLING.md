---
# DRAFT example, AIP-74 v0.4 (billing/v1). Illustrative product file; nothing here describes a real deployment.
schema: billing/v1
name: usage-saas
title: Usage SaaS billing
version: 0.4.0

assets:
  - { ref: aip://49/USD }
  - ref: USAGE_CREDITS
    name: Usage credits
    symbol: USGC
    decimals: 0
    standard: internal
    ruleSet: { settleOut: false, spendableOn: ["*"], convertEdges: [], transfer: none }
    partitions:
      - { id: "USAGE_CREDITS:monthly", asset: USAGE_CREDITS, restriction: [] }   # Autumn feature usage_credits, reset each cycle
      - { id: "USAGE_CREDITS:topup",   asset: USAGE_CREDITS, restriction: [] }   # Autumn feature topup_credits, never expires
primaryAsset: USAGE_CREDITS
anchor: { currency: USD, creditsPerUnit: 1000 }
spendOrder: ["USAGE_CREDITS:monthly", "USAGE_CREDITS:topup"]
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
    to: USAGE_CREDITS
    rail: autumn
    # Computed from the anchor: 1 USD = 1 000 credits; 100 cents -> 1 000 credits (decimals 0 - 2 = -2) (rule 9).
    mint: { partition: "USAGE_CREDITS:topup" }
    enabled: true

offers:
  - id: credit-top-up

    # No minimum and no maximum are configured: the user picks a quantity of 1 000 credits (billingUnits 1000).
    price: { model: prepaid-pool, amountMinor: buyer, currency: USD }
    convert: usd-to-credits
  - id: base-plan
    price: { model: subscription, amountMinor: 1900, currency: USD, interval: month }
    includes:
      - { feature: paid_plan }
      - { feature: managed_service_access }
      - { feature: credits, amountMinor: 10000, partition: "USAGE_CREDITS:monthly", rollover: none }

    # field is left out. `onUpgrade: none`: no proration configured.
    subscription: { anchor: payment, onUpgrade: none }
  - id: bundle-pro-pack
    price: { model: one-time, amountMinor: 9900, currency: USD }
    includes:
      - { feature: paid_plan }
      - { feature: managed_service_access }
      - { feature: credits, amountMinor: 15000, partition: "USAGE_CREDITS:topup" }   # 15 000 credits into topup_credits

rails:
  # The bundle was first sold through Lemon Squeezy; on 2026-09-02 the product owner moved it to Stripe via Autumn
  # case of the earlier draft of this example is gone: one rail. AUTUMN_SECRET_KEY, AUTUMN_WEBHOOK_SECRET, AUTUMN_MODE.
  - { id: autumn, productTag: usage-saas }
---


The case that tests the spec outside our other products: its own anchor (1 000 credits per dollar), credits with no
decimals, Autumn as the rail and as the projection (`toAutumnPlan` has to give back `autumn.config.ts`). Included credits
of a plan and a one-off bundle are allocations, not conversions: an offer of model `one-time` with `includes`.
