---
# DRAFT example, AIP-74 v0.4 (billing/v1). Illustrative product file; nothing here describes a real deployment.
schema: billing/v1
name: acme
title: Acme billing
version: 0.4.0

assets:
  - { ref: aip://49/EUR }
  - { ref: aip://49/USD }
  - ref: ACME_CREDITS
    name: Acme Credits
    symbol: GCR
    decimals: 2
    standard: internal
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }
    partitions:
      - { id: "ACME_CREDITS:general", asset: ACME_CREDITS, restriction: [] }

      - { id: "ACME_CREDITS:bonus", asset: ACME_CREDITS, restriction: [unearned] }
primaryAsset: ACME_CREDITS

# DECIDED 2026-11-20 (~22:36Z): 100 credits = 1 USD, one adjustable field; EUR by a fixed cross rate.
# file is the target.
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }
# Stripe webhook factory: the amount paid is credited whole, `gross`; what Stripe adds is configured on the Stripe side.
taxBasis: gross

features:
  - { id: credits, type: credits }

accounts:
  kinds: [user, organization, group]
  hierarchy: { maxDepth: 1, funding: [pool, allocated_budget] }

payer:
  # funding model is not `pool`. No cascade. Not the generic hierarchy/v1 walk (a personal organization pays from the
  # actor's wallet, not from its parent), hence a vendor strategy.
  strategy: x-acme:org-kind
  owner: [organizationId, groupId, userId]
transfers:
  allow: [allocate]
  from: ["ACME_CREDITS:general"]
  expiry: inherit

conversions:
  - id: eur-to-credits

    from: EUR
    to: ACME_CREDITS
    rail: stripe
    mint: { partition: "ACME_CREDITS:general" }
    bonus: { strategy: tiered-lots/v1, partition: "ACME_CREDITS:bonus", tiers: [[50000, 12], [10000, 12], [0, 10]] }

    enabled: true
  - id: usd-to-credits       # a second price, not an exchange rate: computed 100 x 1 = 100
    from: USD
    to: ACME_CREDITS
    rail: stripe
    mint: { partition: "ACME_CREDITS:general" }
    bonus: { strategy: tiered-lots/v1, partition: "ACME_CREDITS:bonus", tiers: [[50000, 12], [10000, 12], [0, 10]] }
    enabled: true

offers:
  # the id as <pack>_<currency>). Credits come from the conversion plus its bonus tier.
  - { id: starter_eur, price: { model: prepaid-pool, amountMinor: 1000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_starter_eur } } }
  - { id: growth_eur, price: { model: prepaid-pool, amountMinor: 5000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_growth_eur } } }
  - { id: scale_eur, price: { model: prepaid-pool, amountMinor: 10000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_scale_eur } } }
  - { id: pro_eur, price: { model: prepaid-pool, amountMinor: 50000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_pro_eur } } }
  - { id: starter_usd, price: { model: prepaid-pool, amountMinor: 1000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_starter_usd } } }
  - { id: growth_usd, price: { model: prepaid-pool, amountMinor: 5000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_growth_usd } } }
  - { id: scale_usd, price: { model: prepaid-pool, amountMinor: 10000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_scale_usd } } }
  - { id: pro_usd, price: { model: prepaid-pool, amountMinor: 50000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_pro_usd } } }
  # The seat fee is the plan price. Included credits are an allocation fixed per plan, the same in EUR and USD
  # (monthlyCredits 2200 / 5500 / 11500 / 21000) and do NOT follow the anchor today. The free plan (200 credits per
  # routes failed renewals to it was not verified.
  # `onUpgrade: none`: no proration code was found in the Acme billing module.
  - id: acme_starter_month_eur
    price: { model: subscription, amountMinor: 2000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 220000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_starter_monthly_eur } }
  - id: acme_starter_month_usd
    price: { model: subscription, amountMinor: 2000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 220000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_starter_monthly_usd } }
  - id: acme_pro_month_eur
    price: { model: subscription, amountMinor: 5000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 550000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_pro_monthly_eur } }
  - id: acme_pro_month_usd
    price: { model: subscription, amountMinor: 5000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 550000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_pro_monthly_usd } }
  - id: acme_team_month_eur
    price: { model: subscription, amountMinor: 10000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 1150000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_team_monthly_eur } }
  - id: acme_team_month_usd
    price: { model: subscription, amountMinor: 10000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 1150000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_team_monthly_usd } }
  - id: acme_enterprise_month_eur
    price: { model: subscription, amountMinor: 20000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 2100000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_enterprise_monthly_eur } }
  - id: acme_enterprise_month_usd
    price: { model: subscription, amountMinor: 20000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 2100000, partition: "ACME_CREDITS:general", rollover: unbounded } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: acme_enterprise_monthly_usd } }

grants:
  - id: welcome
    trigger: { kind: manual }

    amount: { fixedMinor: 50000 }             # 500 credits (5 USD at the anchor)
    partition: "ACME_CREDITS:general"
    key: "{account}:once"

rails:
  - { id: stripe, productTag: acme }


metadata:
  acme:
    marginFloorPercent: 10

    postpaid: { kinds: [organization], cycle: month }
---

# Acme

The monthly renewal of today (`acme.subscription-renewal`, key `renewal:<plan>:<yyyy-mm>`) becomes the `includes` of
the plan, given for each paid period with the cause of the invoice.
