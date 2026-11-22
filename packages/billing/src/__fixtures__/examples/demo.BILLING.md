---
# DRAFT example, AIP-BILLING v0.4 (billing/v1). Describes Demo as deployed from main on 2026-11-20, with ONE exception
# decided the same day: the credit anchor (100 credits = 1 USD, EUR derived from fx). Where deployed code differs,
# the comment cites the file and says so; migrating Demo to this file is a later step and nothing in this file is
# read by Demo today. Minor units: euro cents, hundredths of a credit (credits have decimals 2).
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
    # assets-catalog.ts:108 declares peg { vs: EUR, source: "fixed:0.01" } (1 credit = 0.01 EUR). Under the anchor the
    # peg is derived (rule 26) and not declared here. MIGRATION PENDING (step 5a).
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }   # assets-catalog.ts:109-114
    partitions:                                             # assets-catalog.ts:115-
      - { id: "DEMO_CREDITS:welcome",      asset: DEMO_CREDITS, restriction: [welcome],    defaultTtlMs: 2592000000 }   # 30 days
      - { id: "DEMO_CREDITS:grant",        asset: DEMO_CREDITS, restriction: [grant] }
      - { id: "DEMO_CREDITS:purchased",    asset: DEMO_CREDITS, restriction: [] }
      # NEW, not in assets-catalog.ts: today the whole pack (base + bonus, `centicredits` of packs.ts) is minted as one
      # purchased lot. A separate bonus lot is AIP-BILLING rule 12. MIGRATION PENDING (step 5a).
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
# Deployed code sells at 100 credits per EUR: DEMO_PACKS in packs.ts:22-86 (200 credits for 2 EUR),
# salePeg { EUR: 100 } in kit.ts:45, CENTICREDITS_PER_EUR = 10_000 in packages/core/src/config/action-cost.ts:51,
# CREDIT_USD_RATE = 0.0108 in packages/model-catalog pricing. The 118 per EUR of PawaPay (CREDITS_PER_EUR,
# credits.service.ts:95, deprecated) is a third value. MIGRATION OF DEMO PENDING (step 5a); this file is the target.
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }                                   # 1 EUR = 118 credits (rule 26)
# No spendOrder: kit.ts:63-72 declares no spendOrder policy, the AIP-49 order applies (default-policies.ts:49).
# OPEN DECISION (tax basis, VAT included or not). Today the pack's credits are fixed per pack (packs.ts) and do not
# depend on the tax Stripe adds, so the amount paid is credited whole: `gross`. Nothing in the code reads a tax basis.
taxBasis: gross

features:
  - { id: credits, type: credits }

accounts:
  kinds: [user]
  hierarchy: { maxDepth: 0, funding: [] }
payer:
  strategy: self
  owner: [userId]            # kit.ts:73-75: Demo resolves the payer itself (the user's personal account); keys inferred

conversions:
  - id: eur-to-credits       # buying a pack is converting euros into credits; the rate is computed: 100 x 1.18 = 118
    from: EUR
    to: DEMO_CREDITS
    rail: stripe
    # No `expires`: purchased credits get an expiry only when CREDIT_LIMIT_TOPUP_EXPIRY_ENABLED is on, and it defaults
    # to off (assets-catalog.ts:131-140). The 12-month rule of decision D-Q5 is planned for after the terms announcement.
    mint: { partition: "DEMO_CREDITS:purchased" }
    bonus:
      strategy: tiered-lots/v1
      partition: "DEMO_CREDITS:bonus"
      # kit.ts:34-41. The 50 EUR tier is 50 by default and 30 when PACK50_BONUS_30=on (billing-registry.ts:187-216);
      # 30 here is taken from docs/demo-credit-economics.md:118 (setting active in production since 2026-11-16),
      # not read from the running service.
      tiers: [[5000, 30], [2500, 30], [1000, 20], [500, 10], [0, 0]]
    enabled: true
  # PawaPay is out of v1 (decision 2026-11-20); its 118 credits per EUR path is not described here.
  - id: points-to-credits    # /convertir; terms from points-conversion.config.ts
    from: DEMO_POINTS
    to: DEMO_CREDITS
    rate: { kind: fixed, ratio: 1 }    # default 1 credit per point (config:46-49), overridable by env POINTS_CONVERSION_CREDITS_PER_POINT
    mint: { partition: "DEMO_CREDITS:grant" }
    # The 100-point minimum and the optional cap per conversion (POINTS_CONVERSION_MIN_POINTS, _MAX_POINTS) are env
    # settings with no field here: one product only (weight rule). No cap by default.
    enabled: false           # POINTS_CONVERSION is off unless set to "on"; still checked by the no-arbitrage rule

offers:
  # Packs (packs.ts). The credits come from the conversion, not from the offer. Ids and Stripe lookup keys are the
  # deployed ones: the id carries the legacy credit count of the pack and no longer states it (at 118 per EUR the
  # 20 EUR pack gives 2360 + 472, not 2400).
  - { id: credits_200,  price: { model: prepaid-pool, amountMinor: 200,  currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_200 } } }
  - { id: credits_550,  price: { model: prepaid-pool, amountMinor: 500,  currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_550 } } }
  - { id: credits_1200, price: { model: prepaid-pool, amountMinor: 1000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_1200 } } }
  - { id: credits_2400, price: { model: prepaid-pool, amountMinor: 2000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_2000 } } }
  # credits_3250 (25 EUR) is disabled and hidden (packs.ts:63-72), kept only for reverse lookup of old payments: not an offer.
  - { id: credits_7500, price: { model: prepaid-pool, amountMinor: 5000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: demo_credits_7500 } } }
  # Plans (plans-data.ts:377-585). Monthly only: yearly prices exist (x10, same lookup keys with "yearly") and their
  # per-month credit grants follow another path (paid-period-credits.ts), not represented in this version.
  # The included credits are an allocation, fixed per plan (GO_MONTHLY, PLUS_MONTHLY, MAX_MONTHLY, plans-data.ts:84-86),
  # the same in EUR and USD, and do NOT follow the anchor today: 600 / 2700 / 9000 credits.
  # A country override exists in code but is commented out (plans-data.ts:905).
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
  # `rollover: none`: the subscription lot expires at the period end (renewalExpiry, grants-catalog.ts:218).
  # The wipe-on-drop flag ENABLE_SUBSCRIPTION_WIPE_ON_GRANT (default false, packages/env demo-api.ts:1017) is separate.
  # `anchor: calendar`: the calendar sweep credits on the 1st (grants-catalog.ts:186-199). With DEMO_CREDIT_ON_PAYMENT_DATE
  # on (default off) it becomes `payment`, with expiry at the period end + 1 day (paid-period-credits.ts:24): a new version.
  # OPEN DECISION (grace after a refused renewal): P7D is the shared grace of subscription.service.ts:1760
  # (startGracePeriod); the paid-period path uses a 1 day slack. DIVERGES from rule 17: includes do NOT continue during
  # grace today, the monthly sweep is restricted to ACTIVE and TRIALING subscriptions (grants-catalog.ts:168-175,209).
  # `onUpgrade: none` is the choice recorded as decision 4.6; no proration code was found.
  # Legacy plans (nano, mini, lite, pro) are inactive, no new subscription: not offers (plans-data.ts:586-).

grants:
  - id: welcome
    trigger: { kind: manual }                # fired on account activation (grants-catalog.ts:133-148), key activation:<userId>
    amount: { strategy: "x-agentik:welcome-by-country" }   # 100 credits by default, per-country override (waitlist.config.ts:23,104-116)
    partition: "DEMO_CREDITS:welcome"
    expires: { after: P30D }
    key: "{account}:once"
  - id: free-weekly-topup
    # Weekly cadence sweep, Saturday 12:00 Europe/Paris (grants-catalog.ts:277-279). AIP-41 carries the timezone.
    trigger: { kind: cron, cron: "0 12 * * 6", timezone: Europe/Paris }
    eligible: { plans: [none] }              # scope: demo_free and demo_free_verified (grants-catalog.ts:315)
    amount: { fixedMinor: 1000 }             # 10 credits (plans-data.ts:71-73, DEMO_FREE_OFFERED_CREDITS.amountCc = 1000)
    mode: top-up                             # resetOnDrop: the next drop replaces the previous remainder
    partition: "DEMO_CREDITS:free-weekly"
    key: "{account}:{period}"
  - id: free-dotation
    # Fired by the monthly processor for free accounts with a usage event in the last 30 days (free-dotation-processor.ts:36-39;
    # mode FREE_MONTHLY_DOTATION is off by default). The catalog entry itself has no scope (grants-catalog.ts:335-).
    trigger: { kind: manual }
    eligible: { plans: [none] }
    amount: { fromContext: true }
    partition: "DEMO_CREDITS:free-monthly"
    key: "{account}:{period}"

rails:
  - { id: stripe, productTag: demo }       # STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MODE (kit.ts:51-52); allowLive and expectAccount stay in host configuration

---

# Demo

Trace of a 20 EUR pack under the anchor: `mint 2000 EUR` (cause `stripe:pi_...`), conversion to 236 000 hundredths in
`purchased`, `mint 47 200` in `bonus`: 2 832 credits of which 472 offered, all with the same cause. Deployed today:
2 400 credits, bonus included, in one lot.

Not repeated here (same form, `trigger: manual`): `legacy-welcome`, `verification`, `promo`, `reward`, `gift`,
`points-redemption`, `prepaid-card`, `promo-fast`.
