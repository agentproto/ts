---
# DRAFT example, AIP-BILLING v0.4 (billing/v1). Describes ChatCommerce as deployed from main on 2026-11-20, except the
# credit anchor and the EUR rate below. Where deployed code differs, the comment cites the file and says so.
# Minor units: euro cents, hundredths of a credit (decimals 2).
# Paths are in the Agentik studio repository (private); they are provenance, not links.
schema: billing/v1
name: chatcommerce
title: ChatCommerce billing
version: 0.4.0

assets:
  - { ref: aip://49/EUR }
  - { ref: aip://49/USD }     # the anchor currency is declared even when nothing is sold in it
  - ref: CHATCOMMERCE_CREDITS
    name: ChatCommerce Credits
    symbol: CCR
    decimals: 2
    standard: internal
    # No wallet asset exists today: credits live on the kit tables with two origins, purchased and subscription
    # (kit-credits.ts:65-76). This declaration is derived for the file. 1 displayed credit = 100 centicredits.
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }
    partitions:
      - { id: "CHATCOMMERCE_CREDITS:purchased",    asset: CHATCOMMERCE_CREDITS, restriction: [] }
      - { id: "CHATCOMMERCE_CREDITS:subscription", asset: CHATCOMMERCE_CREDITS, restriction: [] }   # the monthly envelope
      - { id: "CHATCOMMERCE_CREDITS:welcome",      asset: CHATCOMMERCE_CREDITS, restriction: [welcome] }
      # NEW, not declared today: a separate bonus lot is AIP-BILLING rule 12. MIGRATION PENDING.
      - { id: "CHATCOMMERCE_CREDITS:bonus",        asset: CHATCOMMERCE_CREDITS, restriction: [unearned] }
primaryAsset: CHATCOMMERCE_CREDITS

# Rate decided on 2026-11-20; production moves to this rate at step 5a.1. Current code: chatcommerce-billing.ts:40-41,
# plan-envelopes.ts:41.
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }
taxBasis: net              # prices are excluding tax (chatcommerce-billing.ts:40, plan-envelopes.ts:9)

features:
  - { id: credits, type: credits }
  # Boolean rights per plan (PLAN_RIGHTS, rights/registry.ts:62-). The numeric limit shopCap and the other plan limits
  # (PLAN_SHOP_CAPS, plan-limits.ts) are not features: they stay in TypeScript.
  - { id: cart, type: boolean }
  - { id: branding, type: boolean }
  - { id: agency_console, type: boolean }

accounts:
  kinds: [organization, agency]
  hierarchy: { maxDepth: 1, funding: [pool, allocated_budget] }   # chatcommerce-billing.ts:49 (childModels pool, allocated)
payer:
  strategy: hierarchy/v1
  owner: [orgId]           # scopeToOwner, chatcommerce-billing.ts:51
  affordability: spendable # chatcommerce-billing.ts:52
transfers:
  # An agency allocates credits to a client organization from its purchased credits (agency-credits.ts:179-194,
  # model `allocated` only), and can take back (agency-credits.ts:17). Off unless AGENCY_ACCOUNTS_ENABLED=1
  # (contract.ts:84; the production value was not verified).
  allow: [allocate, reclaim]
  from: ["CHATCOMMERCE_CREDITS:purchased"]
  expiry: inherit

conversions:
  - id: eur-to-credits     # rate computed: 100 x 1.18 = 118
    from: EUR
    to: CHATCOMMERCE_CREDITS
    rail: stripe
    # Purchased credits are valid 12 months (PURCHASED_CREDIT_VALIDITY_MONTHS, catalog.ts:212; kit-credits.ts:246).
    mint: { partition: "CHATCOMMERCE_CREDITS:purchased", expires: { after: P12M } }
    # Volume bonus on a free-amount purchase, PURCHASE_BONUS_TIERS (chatcommerce-billing.ts:17-23). Purchases only:
    # the plan bonus below is another thing.
    bonus: { strategy: tiered-lots/v1, partition: "CHATCOMMERCE_CREDITS:bonus", tiers: [[30001, 15], [12000, 10], [6000, 5], [0, 0]] }
    enabled: true

offers:
  - id: credits            # free amount, bounds MIN_PURCHASE_CENTS and MAX_PURCHASE_CENTS (purchase.ts:30-31)
    price: { model: prepaid-pool, amountMinor: buyer, minMinor: 1000, maxMinor: 100000, currency: EUR }
    convert: eur-to-credits
  # Plans (PLAN_PRICE_EUR, plan-envelopes.ts:19-25), monthly, excluding tax.
  # The envelopes do NOT go through the conversion: they are included credits, an allocation of the period, computed
  # outside the file by planEnvelopeCredits (plan-envelopes.ts:37-43) = price x credits per EUR x (1 + plan bonus),
  # rounded to the nearest hundred; the plan bonus is 10 / 15 / 20 % (PLAN_BONUS_PERCENT, chatcommerce-billing.ts:26-31),
  # not the purchase tiers. Written here: 79 x 118 x 1.10 = 10 300, 149 x 118 x 1.15 = 20 200,
  # 399 x 118 x 1.20 = 56 500 (rate decided on 2026-11-20; production moves to it at step 5a.1).
  # OPEN DECISION (rollover): `none` is today's behaviour, the envelope expires at the end of its calendar month
  # (kit-credits.ts:206-225, endOfPeriod); `unbounded` would carry it over.
  # `anchor: calendar`: the envelope of a month is granted once, on first use in the month (gate.ts:50-69).
  # OPEN DECISION (grace): there is no grace today. A past_due subscription keeps access but nothing runs: level
  # no_draws (entitlement.ts:49-50). No `grace` field means no grace.
  # `onUpgrade: none`: no proration code was found in the cloud billing module.
  - id: visibilite
    price: { model: subscription, amountMinor: 7900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 1030000, partition: "CHATCOMMERCE_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, onUpgrade: none }
  - id: visibilite_agentcart
    price: { model: subscription, amountMinor: 14900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 2020000, partition: "CHATCOMMERCE_CREDITS:subscription", rollover: none }, { feature: cart } ]
    subscription: { anchor: calendar, onUpgrade: none }
  - id: agence
    price: { model: subscription, amountMinor: 39900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 5650000, partition: "CHATCOMMERCE_CREDITS:subscription", rollover: none }, { feature: cart }, { feature: branding }, { feature: agency_console } ]
    subscription: { anchor: calendar, onUpgrade: none }

grants:
  - id: welcome
    trigger: { kind: manual }                     # at signup completion (pg-welcome-grants.ts)
    # The amount is the operator setting onboarding.welcome_grant_credits stored in the database (app-settings.contract.ts:13-24);
    # plan-envelopes.ts:23 speaks of "50 + 50". Each grant carries its own expiry and is bounded by a daily budget and
    # by e-mail, shop and IP deduplication (pg-welcome-grants.ts:21-): behaviour that stays in TypeScript.
    amount: { strategy: "x-agentik:welcome-grant" }
    partition: "CHATCOMMERCE_CREDITS:welcome"
    key: "{account}:once"

rails:
  # ChatCommerce keeps its own Stripe provider today (stripeAccounts: [], chatcommerce-billing.ts:13-14, 42): the rail
  # is declared here for the step that adopts it. Credits are inert while CREDITS_ENABLED is off (store.ts:155).
  - { id: stripe, productTag: chatcommerce }
---

# ChatCommerce

Provenance: `projects/agentcart/cloud/src/billing/chatcommerce-billing.ts` and
`src/credits/{catalog,plan-envelopes,purchase,gate}.ts`, `src/store/{kit-credits,agency-credits}.ts` of the Agentik studio.
