---
# DRAFT example, AIP-74 v0.4 (billing/v1). Illustrative product file; nothing here describes a real deployment.
schema: billing/v1
name: demo
title: Demo billing
version: 0.4.0

assets:
  - { ref: aip://49/EUR }
  - { ref: aip://49/USD }
  - ref: DEMO_CREDITS
    name: Demo Credits
    symbol: SCR
    decimals: 2
    standard: internal
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }

    partitions:

      - { id: "DEMO_CREDITS:welcome",      asset: DEMO_CREDITS, restriction: [welcome],    defaultTtlMs: 2592000000 }   # 30 days
      - { id: "DEMO_CREDITS:grant",        asset: DEMO_CREDITS, restriction: [grant] }
      - { id: "DEMO_CREDITS:purchased",    asset: DEMO_CREDITS, restriction: [] }
      - { id: "DEMO_CREDITS:bonus",        asset: DEMO_CREDITS, restriction: [unearned] }
      - { id: "DEMO_CREDITS:subscription", asset: DEMO_CREDITS, restriction: [] }
      - { id: "DEMO_CREDITS:promo-fast",   asset: DEMO_CREDITS, restriction: [promo-fast], spendableOn: ["llm_generation:tier:fast"], defaultTtlMs: 2592000000 }   # inert: no trigger fires it
      - { id: "DEMO_CREDITS:free-weekly",  asset: DEMO_CREDITS, restriction: [unearned],   defaultTtlMs: 604800000 }    # 7 days
      - { id: "DEMO_CREDITS:free-monthly", asset: DEMO_CREDITS, restriction: [unearned],   defaultTtlMs: 2592000000 }
      - { id: "DEMO_CREDITS:verification", asset: DEMO_CREDITS, restriction: [unearned],   defaultTtlMs: 2592000000 }
      - { id: "DEMO_CREDITS:image-free",   asset: DEMO_CREDITS, restriction: [unearned],   spendableOn: ["image_generation:tier:light"] }
  - ref: DEMO_POINTS
    name: Demo Points
    symbol: SPT
    decimals: 0
    standard: internal
    ruleSet: { settleOut: false, spendableOn: [], convertEdges: [], transfer: none }
    partitions:
      - { id: "DEMO_POINTS:default", asset: DEMO_POINTS, restriction: [], defaultTtlMs: 31536000000 }   # 12 months
primaryAsset: DEMO_CREDITS

# DECIDED 2026-11-20 (~22:36Z): 100 credits = 1 USD, one adjustable field; EUR by a fixed cross rate.
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }                                   # 1 EUR = 118 credits (rule 26)
taxBasis: gross

features:
  - { id: credits, type: credits }

accounts:
  kinds: [user]
  hierarchy: { maxDepth: 0, funding: [] }
payer:
  strategy: self
  owner: [userId]


conversions:
  - id: eur-to-credits       # buying a pack is converting euros into credits; the rate is computed: 100 x 1.18 = 118
    from: EUR
    to: DEMO_CREDITS
    rail: stripe
    # No `expires`: purchased credits get an expiry only when CREDIT_LIMIT_TOPUP_EXPIRY_ENABLED is on, and it defaults
    mint: { partition: "DEMO_CREDITS:purchased" }
    bonus:
      strategy: tiered-lots/v1
      partition: "DEMO_CREDITS:bonus"
      tiers: [[5000, 30], [2500, 30], [1000, 20], [500, 10], [0, 0]]
    enabled: true
  # PawaPay is out of v1 (decision 2026-11-20); its 118 credits per EUR path is not described here.
  - id: points-to-credits

    from: DEMO_POINTS
    to: DEMO_CREDITS
    rate: { kind: fixed, ratio: 1 }    # default 1 credit per point (config:46-49), overridable by env POINTS_CONVERSION_CREDITS_PER_POINT
    mint: { partition: "DEMO_CREDITS:grant" }
    # The 100-point minimum and the optional cap per conversion (POINTS_CONVERSION_MIN_POINTS, _MAX_POINTS) are env
    # settings with no field here: one product only (weight rule). No cap by default.
    enabled: false           # POINTS_CONVERSION is off unless set to "on"; still checked by the no-arbitrage rule

offers:
  # 20 EUR pack gives 2360 + 472, not 2400).
  - { id: credits_200,  price: { model: prepaid-pool, amountMinor: 200,  currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_200 } } }
  - { id: credits_550,  price: { model: prepaid-pool, amountMinor: 500,  currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_550 } } }
  - { id: credits_1200, price: { model: prepaid-pool, amountMinor: 1000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_1200 } } }
  - { id: credits_2400, price: { model: prepaid-pool, amountMinor: 2000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_2000 } } }
  - { id: credits_7500, price: { model: prepaid-pool, amountMinor: 5000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_7500 } } }
  - id: demo_go_month_eur
    price: { model: subscription, amountMinor: 500, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 60000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_go_monthly_eur } }
  - id: demo_go_month_usd
    price: { model: subscription, amountMinor: 500, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 60000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_go_monthly_usd } }
  - id: demo_plus_month_eur
    price: { model: subscription, amountMinor: 2000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 270000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_plus_monthly_eur_v2 } }
  - id: demo_plus_month_usd
    price: { model: subscription, amountMinor: 2000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 270000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_plus_monthly_usd_v2 } }
  - id: demo_max_month_eur
    price: { model: subscription, amountMinor: 6000, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 900000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_max_monthly_eur } }
  - id: demo_max_month_usd
    price: { model: subscription, amountMinor: 6000, currency: USD, interval: month }
    includes: [ { feature: credits, amountMinor: 900000, partition: "DEMO_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, grace: P7D, onUpgrade: none }
    rail: { stripe: { lookupKey: demo_max_monthly_usd } }

grants:
  - id: welcome
    trigger: { kind: manual }

    amount: { strategy: "x-acme:welcome-by-country" }

    partition: "DEMO_CREDITS:welcome"
    expires: { after: P30D }
    key: "{account}:once"
  - id: free-weekly-topup
    trigger: { kind: cron, cron: "0 12 * * 6", timezone: Europe/Paris }
    eligible: { plans: [none] }

    amount: { fixedMinor: 1000 }

    mode: top-up                             # resetOnDrop: the next drop replaces the previous remainder
    partition: "DEMO_CREDITS:free-weekly"
    key: "{account}:{period}"
  - id: free-dotation
    trigger: { kind: manual }
    eligible: { plans: [none] }
    amount: { fromContext: true }
    partition: "DEMO_CREDITS:free-monthly"
    key: "{account}:{period}"

rails:
  - { id: stripe, productTag: demo }


---

# Demo

Trace of a 20 EUR pack under the anchor: `mint 2000 EUR` (cause `stripe:pi_...`), conversion to 236 000 hundredths in
`purchased`, `mint 47 200` in `bonus`: 2 832 credits of which 472 offered, all with the same cause. Deployed today:
2 400 credits, bonus included, in one lot.

Not repeated here (same form, `trigger: manual`): `legacy-welcome`, `verification`, `promo`, `reward`, `gift`,
`points-redemption`, `prepaid-card`, `promo-fast`.
