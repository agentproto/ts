/**
 * The reference manifest of the SET-* cases (`@agentproto/billing`, `testing/reference-manifest.ts`),
 * with its rail served by this provider: `stripe` instead of `fake`. Test data, not any product's.
 */
export const STRIPE_REFERENCE_MANIFEST = `---
schema: billing/v1
name: reference
title: Reference manifest for the BILL conformance cases
version: 1.0.0
assets:
  - { ref: aip://49/EUR }
  - { ref: aip://49/USD }
  - ref: REF_CREDITS
    name: Reference credits
    symbol: RCR
    decimals: 2
    standard: internal
    ruleSet: { settleOut: internal-ledger, spendableOn: ["*"], convertEdges: [], transfer: internal }
    partitions:
      - { id: "REF_CREDITS:purchased", asset: REF_CREDITS, restriction: [] }
      - { id: "REF_CREDITS:bonus", asset: REF_CREDITS, restriction: [unearned] }
      - { id: "REF_CREDITS:subscription", asset: REF_CREDITS, restriction: [] }
      - { id: "REF_CREDITS:grant", asset: REF_CREDITS, restriction: [grant] }
      - { id: "REF_CREDITS:weekly", asset: REF_CREDITS, restriction: [unearned], defaultTtlMs: 604800000 }
  - ref: REF_POINTS
    name: Reference points
    symbol: RPT
    decimals: 0
    standard: internal
    ruleSet: { settleOut: false, spendableOn: [], convertEdges: [], transfer: none }
    partitions:
      - { id: "REF_POINTS:default", asset: REF_POINTS, restriction: [] }
primaryAsset: REF_CREDITS
anchor: { currency: USD, creditsPerUnit: 100 }
fx: { EUR: 1.18 }
taxBasis: gross
features:
  - { id: credits, type: credits }
  - { id: pro, type: boolean }
accounts:
  kinds: [org, team, user]
  hierarchy: { maxDepth: 3, funding: [pool, allocated_budget] }
payer: { strategy: hierarchy/v1, owner: [orgId], affordability: spendable }
transfers: { allow: [allocate, reclaim], from: ["REF_CREDITS:purchased"], expiry: inherit }
conversions:
  - id: eur-to-credits
    from: EUR
    to: REF_CREDITS
    rail: stripe
    mint: { partition: "REF_CREDITS:purchased", expires: { after: P12M } }
    bonus: { strategy: tiered-lots/v1, partition: "REF_CREDITS:bonus", tiers: [[5000, 30], [2500, 30], [1000, 20], [500, 10], [0, 0]] }
    enabled: true
  - id: usd-to-credits
    from: USD
    to: REF_CREDITS
    rail: stripe
    mint: { partition: "REF_CREDITS:purchased" }
    enabled: true
  - id: points-to-credits
    from: REF_POINTS
    to: REF_CREDITS
    rate: { kind: fixed, ratio: 1 }
    mint: { partition: "REF_CREDITS:grant" }
    capMinor: { amount: 1000, windowSec: 86400 }
    enabled: false
offers:
  - { id: pack-20, price: { model: prepaid-pool, amountMinor: 2000, currency: EUR }, convert: eur-to-credits }
  - { id: pack-usd, price: { model: prepaid-pool, amountMinor: 1000, currency: USD }, convert: usd-to-credits }
  - { id: top-up, price: { model: prepaid-pool, amountMinor: buyer, minMinor: 1000, maxMinor: 100000, currency: EUR }, convert: eur-to-credits }
  - id: plan-month
    price: { model: subscription, amountMinor: 500, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 60000, partition: "REF_CREDITS:subscription", rollover: none }, { feature: pro } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
  - id: plan-year
    price: { model: subscription, amountMinor: 5000, currency: EUR, interval: year }
    includes: [ { feature: credits, amountMinor: 60000, partition: "REF_CREDITS:subscription", rollover: none }, { feature: pro } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none }
  - id: plan-keep
    price: { model: subscription, amountMinor: 900, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 10000, partition: "REF_CREDITS:subscription", rollover: unbounded } ]
    subscription: { anchor: payment, onUpgrade: none }
  - { id: pack-promo, price: { model: prepaid-pool, amountMinor: 2000, currency: EUR }, convert: eur-to-credits, discounts: allow }
  - id: plan-trial
    price: { model: subscription, amountMinor: 500, currency: EUR, interval: month }
    includes: [ { feature: credits, amountMinor: 60000, partition: "REF_CREDITS:subscription", rollover: none }, { feature: pro } ]
    subscription: { anchor: payment, grace: P7D, onUpgrade: none, trial: P14D }
  - id: bundle
    price: { model: one-time, amountMinor: 9900, currency: USD }
    includes: [ { feature: credits, amountMinor: 15000, partition: "REF_CREDITS:purchased" }, { feature: pro } ]
grants:
  - id: weekly-a
    trigger: { kind: cron, cron: "0 12 * * 6", timezone: Europe/Paris }
    eligible: { plans: [none] }
    amount: { fixedMinor: 1000 }
    mode: top-up
    partition: "REF_CREDITS:weekly"
    key: "{account}:{period}"
  - id: weekly-b
    trigger: { kind: calendar, rrule: "FREQ=WEEKLY;BYDAY=MO" }
    amount: { fixedMinor: 500 }
    partition: "REF_CREDITS:grant"
    key: "{account}:{period}"
  - id: welcome
    trigger: { kind: manual }
    amount: { fixedMinor: 5000 }
    partition: "REF_CREDITS:grant"
    key: "{account}:once"
rails:
  - { id: stripe, productTag: reference }
---

# Reference manifest
`
