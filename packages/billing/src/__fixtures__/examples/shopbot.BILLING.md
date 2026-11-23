---
# DRAFT example, AIP-74 v0.4 (billing/v1). Illustrative product file; nothing here describes a real deployment.
schema: billing/v1
name: shopbot
title: Shopbot billing
version: 0.4.0

assets:
  - { ref: aip://49/EUR }
  - { ref: aip://49/USD }     # the anchor currency is declared even when nothing is sold in it
  - ref: SHOPBOT_CREDITS
    name: Shopbot Credits
    symbol: CCR
    decimals: 2
    standard: internal
    # No wallet asset exists today: credits live on separate tables with two origins, purchased and subscription
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }
    partitions:
      - { id: "SHOPBOT_CREDITS:purchased",    asset: SHOPBOT_CREDITS, restriction: [] }
      - { id: "SHOPBOT_CREDITS:subscription", asset: SHOPBOT_CREDITS, restriction: [] }   # the monthly envelope
      - { id: "SHOPBOT_CREDITS:welcome",      asset: SHOPBOT_CREDITS, restriction: [welcome] }
      - { id: "SHOPBOT_CREDITS:bonus",        asset: SHOPBOT_CREDITS, restriction: [unearned] }
primaryAsset: SHOPBOT_CREDITS

anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }
taxBasis: net


features:
  - { id: credits, type: credits }
  - { id: cart, type: boolean }
  - { id: branding, type: boolean }
  - { id: agency_console, type: boolean }

accounts:
  kinds: [organization, agency]
  hierarchy: { maxDepth: 1, funding: [pool, allocated_budget] }

payer:
  strategy: hierarchy/v1
  owner: [orgId]

  affordability: spendable

transfers:
  allow: [allocate, reclaim]
  from: ["SHOPBOT_CREDITS:purchased"]
  expiry: inherit

conversions:
  - id: eur-to-credits     # rate computed: 100 x 1.18 = 118
    from: EUR
    to: SHOPBOT_CREDITS
    rail: stripe
    mint: { partition: "SHOPBOT_CREDITS:purchased", expires: { after: P12M } }
    bonus: { strategy: tiered-lots/v1, partition: "SHOPBOT_CREDITS:bonus", tiers: [[30001, 15], [12000, 10], [6000, 5], [0, 0]] }
    enabled: true

offers:
  - id: credits
    price: { model: prepaid-pool, amountMinor: buyer, minMinor: 1000, maxMinor: 100000, currency: EUR }
    convert: eur-to-credits
  # The envelopes do NOT go through the conversion: they are included credits, an allocation of the period, computed
  # not the purchase tiers. Written here: 79 x 118 x 1.10 = 10 300, 149 x 118 x 1.15 = 20 200,
  # `onUpgrade: none`: no proration code was found in the cloud billing module.
  - id: visibilite
    price: { model: subscription, amountMinor: 7900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 1030000, partition: "SHOPBOT_CREDITS:subscription", rollover: none } ]
    subscription: { anchor: calendar, onUpgrade: none }
  - id: visibilite_cartkit
    price: { model: subscription, amountMinor: 14900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 2020000, partition: "SHOPBOT_CREDITS:subscription", rollover: none }, { feature: cart } ]
    subscription: { anchor: calendar, onUpgrade: none }
  - id: agence
    price: { model: subscription, amountMinor: 39900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 5650000, partition: "SHOPBOT_CREDITS:subscription", rollover: none }, { feature: cart }, { feature: branding }, { feature: agency_console } ]
    subscription: { anchor: calendar, onUpgrade: none }

grants:
  - id: welcome
    trigger: { kind: manual }

    amount: { strategy: "x-acme:welcome-grant" }
    partition: "SHOPBOT_CREDITS:welcome"
    key: "{account}:once"

rails:
  - { id: stripe, productTag: shopbot }
---

# Shopbot
