---
# DRAFT example, AIP-74 v0.4 (billing/v1). Describes Acme as deployed from main on 2026-11-20, with ONE exception
# decided the same day: the credit anchor (100 credits = 1 USD, EUR derived from fx). Where deployed code differs,
# the comment cites the file and says so; migrating Acme to this file is a later step (5a) and nothing in this
# file is read by Acme today. Minor units: cents, hundredths of a credit (credits have decimals 2).
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
    # assets-catalog.ts:30 already pegs the credit to 0.01 USD (fixed:0.01), the same value as the anchor.
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }
    partitions:
      - { id: "ACME_CREDITS:general", asset: ACME_CREDITS, restriction: [] }   # the only tranche (grants-catalog.ts:36-37)
      # NEW, not declared today: a separate bonus lot is AIP-74 rule 12. MIGRATION PENDING (step 5a).
      - { id: "ACME_CREDITS:bonus", asset: ACME_CREDITS, restriction: [unearned] }
primaryAsset: ACME_CREDITS

# DECIDED 2026-11-20 (~22:36Z): 100 credits = 1 USD, one adjustable field; EUR by a fixed cross rate.
# Deployed code gives 100 credits per EUR AND per USD (packs.ts header lines 11-14, kit.ts:31 salePeg { USD: 100, EUR: 100 }).
# So USD is unchanged and EUR goes from 100 to 118 at this version. MIGRATION OF ACME PENDING (step 5a); this
# file is the target.
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }
# OPEN DECISION (tax basis, VAT included or not). No tax computation was found in the Acme billing code or in the
# Stripe webhook factory: the amount paid is credited whole, `gross`; what Stripe adds is configured on the Stripe side.
taxBasis: gross

features:
  - { id: credits, type: credits }

accounts:
  kinds: [user, organization, guild]
  hierarchy: { maxDepth: 1, funding: [pool, allocated_budget] }   # per_seat is read as allocated by the studio, no field here
payer:
  # The payer follows the kind of the owning organization (charge-resolver.ts:1-20): personal -> the acting user's own
  # wallet; team -> the organization pool; enterprise -> the pool or a per-guild allocation account when its
  # funding model is not `pool`. No cascade. Not the generic hierarchy/v1 walk (a personal organization pays from the
  # actor's wallet, not from its parent), hence a vendor strategy.
  strategy: x-agentik:org-kind
  owner: [organizationId, guildId, userId]
transfers:
  # An organization pool allocates to a guild account (person-guild-grant.ts: one transfer per guild, idempotent by
  # reference). No reclaim path was found; a granted guild keeps what it got (person-guild-grant.ts:11-15).
  allow: [allocate]
  from: ["ACME_CREDITS:general"]
  expiry: inherit

conversions:
  - id: eur-to-credits       # rate computed: 100 x 1.18 = 118 (deployed today: 100)
    from: EUR
    to: ACME_CREDITS
    rail: stripe
    mint: { partition: "ACME_CREDITS:general" }
    bonus: { strategy: tiered-lots/v1, partition: "ACME_CREDITS:bonus", tiers: [[50000, 12], [10000, 12], [0, 10]] }   # kit.ts:23-27, decision D-Q4
    enabled: true
  - id: usd-to-credits       # a second price, not an exchange rate: computed 100 x 1 = 100
    from: USD
    to: ACME_CREDITS
    rail: stripe
    mint: { partition: "ACME_CREDITS:general" }
    bonus: { strategy: tiered-lots/v1, partition: "ACME_CREDITS:bonus", tiers: [[50000, 12], [10000, 12], [0, 10]] }
    enabled: true

offers:
  # Packs (packs.ts:36-): 10 / 50 / 100 / 500 in each currency, ids and lookup keys as deployed (kit.ts:44-48 builds
  # the id as <pack>_<currency>). Credits come from the conversion plus its bonus tier.
  - { id: starter_eur, price: { model: prepaid-pool, amountMinor: 1000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_starter_eur } } }
  - { id: growth_eur, price: { model: prepaid-pool, amountMinor: 5000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_growth_eur } } }
  - { id: scale_eur, price: { model: prepaid-pool, amountMinor: 10000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_scale_eur } } }
  - { id: pro_eur, price: { model: prepaid-pool, amountMinor: 50000, currency: EUR }, convert: eur-to-credits, rail: { stripe: { lookupKey: acme_pack_pro_eur } } }
  - { id: starter_usd, price: { model: prepaid-pool, amountMinor: 1000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_starter_usd } } }
  - { id: growth_usd, price: { model: prepaid-pool, amountMinor: 5000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_growth_usd } } }
  - { id: scale_usd, price: { model: prepaid-pool, amountMinor: 10000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_scale_usd } } }
  - { id: pro_usd, price: { model: prepaid-pool, amountMinor: 50000, currency: USD }, convert: usd-to-credits, rail: { stripe: { lookupKey: acme_pack_pro_usd } } }
  # Plans (plans-data.ts:113-300), monthly only: yearly prices exist (x10) and are not represented in this version.
  # The seat fee is the plan price. Included credits are an allocation fixed per plan, the same in EUR and USD
  # (monthlyCredits 2200 / 5500 / 11500 / 21000) and do NOT follow the anchor today. The free plan (200 credits per
  # month, plans-data.ts:101) has no price and is not an offer.
  # OPEN DECISION (rollover, carry-over of unspent included credits): `unbounded` is today's behaviour, the renewal
  # adds to the general tranche with no expiry and no reset (grants-catalog.ts:58-71).
  # `anchor: payment`: the grant fires on the SUBSCRIPTION_RENEWED event (grants-catalog.ts:63), key renewal:<plan>:<yyyy-mm>.
  # OPEN DECISION (grace): P7D is the shared SubscriptionService grace (subscription.service.ts:1760); that Acme
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
    trigger: { kind: manual }                 # first guild created (grants-catalog.ts:43-55)
    amount: { fixedMinor: 50000 }             # 500 credits (5 USD at the anchor)
    partition: "ACME_CREDITS:general"
    # Deployed key is signup-bonus:<userId>, one per USER, not per account: the account-level key below is the
    # AIP-74 form (rule 15). MIGRATION PENDING.
    key: "{account}:once"

rails:
  - { id: stripe, productTag: acme }        # STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (kit.ts:37-38); allowLive and expectAccount stay in host configuration

metadata:
  agentik:
    marginFloorPercent: 10                      # decision D-Q4, packs.ts:26-35; not a spec field
    # Postpaid organizations: payment mode `postpaid` settles monthly down to a floor (charge-resolver.ts:20-24,
    # billing-account.schema.ts:67-72). One product only, so out of the spec (two-cases rule).
    postpaid: { kinds: [organization], cycle: month }
---

# Acme

The monthly renewal of today (`acme.subscription-renewal`, key `renewal:<plan>:<yyyy-mm>`) becomes the `includes` of
the plan, given for each paid period with the cause of the invoice.
