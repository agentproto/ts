# @agentproto/billing

Reference implementation of [AIP-74](https://agentproto.sh/docs/aip-74), a
**draft**: the schema and the provider contract may still change between minor
versions while the package is `0.x`.

```
BILLING.md  ->  parseBillingManifest  ->  defineBillingManifest  ->  handle (derived rates, edges)
rail event  ->  SettlementProvider.verifyWebhook  ->  handleRailFact  ->  AIP-49 journal
start-up    ->  assertRailEnv, assertRailCapabilities
```

## What is here

| File | Role |
|---|---|
| `schema.ts` | The zod schema of the frontmatter, mirroring `BILLING.schema.json` (see below). |
| `define-billing-manifest.ts` | `defineBillingManifest`: shape check, cross-reference rules (21), normalisation (22), derived rates from `anchor` and `fx` (26), AIP-49 edges, arbitrage check over every declared edge (14). |
| `manifest/` | `parseBillingManifest` (BILLING.md) and `loadBillingManifest`. |
| `payment.ts` | The payment path: check, fact, effect, trace. One `StoragePort.commit`, idempotent by event id, `traceOf`, `listOwed`. |
| `reclaim.ts` | Refunds (rule 6, never the bonus, cumulative per payment), reversed refunds, and disputes for their amount (freeze, release, reclaim, give back on a late win). |
| `periods.ts` | Paid subscription periods, the include drops (monthly inside a yearly period), `past_due` and grace. |
| `grants.ts`, `payer.ts`, `transfers.ts` | Free credits with deterministic keys, who pays (`self`, `hierarchy/v1`), parent to child allocation. |
| `settlement.ts` | `SettlementProvider`: the AIP-49 `SettlementPort` plus `verifyWebhook` and the required `capabilities`; optional `refund`, `check`, `createCheckout`, `createPortalSession`, `syncCatalog`. The facts (`RailFact`). No second settlement interface. |
| `capabilities.ts` | `assertRailCapabilities`: the start-up check of the offers against what their rails can do. |
| `return-url.ts` | `assertReturnUrl`: the allow list of return origins every provider applies before a checkout or a portal call. |
| `webhook.ts` | `handleRailFact` / `handleWebhook`: the dispatch of every fact, and the facts kept until their payment lands. |
| `registry.ts` | The provider registry, mounted with `makeProviderFamily()` of `@agentproto/provider-kit`; builds a package through its `createProvider` when it exports one. |
| `rails.ts` | Rail variable names, the start-up guard (rule 24), `test` / `live` mode. |
| `spend/` | The spend primitives: `createPricer` (`price`), `createDebit` (`debit`), `createShadow` (`shadow`). Mechanisms only, with neutral defaults. |
| `testing/` | In-memory stores, `FakeSettlementProvider`, a reference manifest and the framework-free BILL-* cases. |
| `contract/` | The contract cases a host or a provider package runs in its CI: spend, holds, and `settlementProviderContractCases` (SET-*). |

No payment provider lives here. A provider is its own package, `@agentproto/billing-<slug>`, that the registry imports by slug (`BILLING_CATALOG` names the expected ones). The Stripe one is [`@agentproto/billing-stripe`](../billing-stripe): webhooks and money facts, checkout, billing portal, refunds and catalog sync, built through `createProvider` with `providerOptions.stripe`. The other entries of the catalog have no package yet.

## Writing a payment provider

A provider implements `SettlementProvider` and declares what its rail can do in `capabilities` (required). Each flag is honest: `true` means the method exists and works, `false` that it is absent or answers `unsupported`.

- **Start-up.** `assertRailCapabilities(manifest, providers)` refuses a manifest that sells an offer its rail cannot serve, naming the offer, the rail and the flag: a subscription on a rail without `subscriptions`, a trial without `trials`, `amountMinor: buyer` without `buyerAmount`, `discounts: allow` without `discounts`, and any offer whose refund path cannot run (`refunds: "none"`, unless `moneyFacts: "delegated"` names in `moneyFactsFrom` a provider that refunds). A `prepaid-pool` offer is sold on the rail of its conversion, every other offer on every declared rail.
- **Facts.** `verifyWebhook` returns one `RailFact` or null: `payment`, `refund` (once it succeeded), `refund_reversed`, `dispute` (`opened`, `won`, `lost`; an inquiry is no fact), `renewal_failed` (the open period goes `past_due` for the grace), `subscription_ended` (the open period closes, reason `canceled` or `unpaid`; the includes given stay). A payment the rail cannot tie to one offer and one payer is still reported, with `unsupported: <reason>`: the core refuses it, mints the money alone and lists it as owed, gives no credit.
- **Checkout and portal.** `createCheckout` returns one of four outcomes (`redirect`, `charged`, `invoice_sent`, `no_payment`) and writes nothing: only the verified webhook writes. It carries `owner` to the payment fact; `payer` is the payer as the rail knows them. Call `assertReturnUrl(url, allowedOrigins)` on every return URL before any call to the rail.
- **Catalog.** `syncCatalog(manifest, { dryRun })` projects the offers and reports `created`, `updated`, `unchanged` and the `degradations` (what the rail cannot carry, by offer and field). It never deletes at the rail; a dry run only reads.
- **Registry.** A package that needs parameters exports `createProvider(ctx)`, with `ctx.env`, `ctx.options` (`BillingRegistryOptions.providerOptions[slug]`) and `ctx.providers(slug)` to reach another provider lazily (a cycle throws). `check()`, when present, is what the registry's `check` answers.
- **Contract cases.** Run `settlementProviderContractCases` in the package's CI with a factory of signed requests in the rail's own vocabulary (`events`). A case whose scenario is missing fails; list it in `unsupported` only when its capability is off.

```ts
import { settlementProviderContractCases } from "@agentproto/billing/contract-tests"
for (const c of settlementProviderContractCases({ provider, stores, clock, events, secrets, returnUrls, misconfigured, railWrites })) it(c.name, c.run)
```

## Facts that arrive before their payment

Webhooks are not ordered. A refund, a refund reversal or a dispute that names a payment the store does not know yet is kept when the `BillingStateStore` implements the two optional methods `deferFact(paymentMovement, fact)` and `takeDeferred(paymentMovement)`: `handleRailFact` answers `deferred`, and applies the kept facts, in the order of their dates, right after their payment is applied through `handleRailFact` (`outcome.deferred`). `InMemoryBillingState` implements them.

A store without them keeps the previous behaviour: the outcome is `unknown_payment` and nothing is written. **The host must then keep such a fact and replay it once the payment is known**, or the credits of a refunded or disputed payment are never taken back. A payment applied with `applyPayment` directly, outside `handleRailFact`, does not apply the kept facts either.

A kept fact whose payment never comes (a refund of another product on a shared rail account) stays in the store: purge it on your own schedule.

Subscription facts are not kept: a `renewal_failed` or `subscription_ended` with no open period is `no_period`, nothing written, and applies when the rail sends it again. Known limit: a `renewal_failed` is applied to the period open when it arrives. A failed attempt delivered after the payment that retried it marks that new, paid period `past_due`; features stay on through the grace, and the next renewal payment closes it as `renewed`.

## The schema

`schema.ts` is written by hand, not emitted by `scripts/scaffold-aip.mjs`: the scaffolder cannot render the draft's `if/then/else` rules or its external `$ref`s, and its output for them does not type-check under zod 4. `src/__tests__/fixtures.test.ts` runs the zod schema and `BILLING.schema.json` (copied under `src/__fixtures__/`, source in `SOURCE.md`) on the four example files and 20 mutations of each, and requires the same verdict. When the draft is vendored under `specs/resources/aip-74/`, switch to the scaffolder.

## Gaps in `@agentproto/wallet` and `@agentproto/product` (not changed here)

- `WalletEvent` has no `cause` or `origin` (AIP-49 amendment, agentproto/agentproto#171). The payment path writes them on every event; a storage adapter that keeps the typed fields only loses `traceOf`.
- `ConvertEdge` has no `excludes`, and `cap` is not enforced (ts#1203). The derived edge carries them on `DerivedConversion`; the host applies the cap itself.
- No `expire` verb: expiry is `expiresAt` on the lot, a `top-up` grant burns the remainder.
- `@agentproto/product` types `prepaid-pool` as unit price only and has no `subscription` (AIP-55 amendment, agentproto/agentproto#172): `offerToProduct` handles `one-time` and names the gap for the rest.
- `StoragePort.commit` is per account: a transfer between two accounts is two commits, ordered and idempotent by id, not one atomic step.

## Reading of the draft where it is silent

- A yearly period gives its includes monthly (twelve drops), which is what rule 7 ("even if scheduled") needs; other intervals give them once.
- `rollover: none` expires the remainder at the end of the drop's window; the last drop also covers the offer's grace (includes continue during it, rule 17).
- A failed check writes the fiat mint alone: the money was received, so its lot stays open and `listOwed` reads it from the journal.
- Tax in the paid amount is burned with the effect (the fiat lot closes); with `taxBasis: net` the conversion input is the net amount.
- `affordability: balance` counts holds as owned, `spendable` removes them.
- An oracle rate with no value passed to `defineBillingManifest` is skipped by the arbitrage check.

## Writing an overlay

The kit knows how to price an event from a cost and one anchor rate, how to spend on the journal, and how to record an event without spending it. It does not know your packs, bonuses, expiries, caps, overdraft policy, fees or per-product prices. Those are **your rules**, and they live in one **overlay**: a package of yours that sits on the kit's primitives and is shared by every app of yours. Do not copy a rule app by app, and do not ask the kit to carry it.

**Money is not pluggable like the rest.** The core keeps invariants nobody can bypass: a key charges once (idempotence), an amount a rule returns can only be lower than the one requested, a lot is never drawn below its `floor` (0 for a prepaid lot), and a rule that throws or answers badly refuses the spend. Your rules are **pure functions that decide** an amount or a refusal; the core **executes** the decision. A rule receives a frozen snapshot (`DebitContext`: the request, what the account can pay, the journal so far) and never a handle that can write.

The shape of an overlay:

1. **Configuration, not code.** Put every value in one object: category margins and floors (`UsageConfig`), caps, limits, what a shortfall does (`shortfall`, no default). The kit has no value of its own for any of them (floor 0, margin 1).
2. **Rules are named and ordered.** `rules: [{ name, decide }]` on `createDebit`. A rule passes with `undefined`, refuses with `{ refuse }` (stops the run) or lowers the amount with `{ amount }` (the next rule sees the lowered amount). The result names the deciding rule (`decidedBy`) and lists the others (`trace`). Order matters and is yours to choose.
3. **Data stays data.** A bonus on a pack and an expiry are declared in `BILLING.md` (`conversions[].bonus`, `expires`) and executed by the payment path; a fee at cost is a category with `margin: at-cost` whose measured cost your code computes; a price book plugs in as `priceBook`. None of these needs a hook.
4. **Keep every write keyed** by the action's key, so a replay writes once.
5. **Stay on the journal.** Prepaid or postpaid is the `floor` of the lots you mint, not a mode of a spend.
6. **Run the contract tests in your CI** and again at every bump of the kit version:

```ts
import { spendContractCases } from "@agentproto/billing/contract-tests"
for (const c of spendContractCases({ stores, clock, manifest })) it(c.name, c.run)
```

A complete, tested example (a rolling-day cap and a per-call maximum as two named rules) is in `src/__tests__/overlay-example.ts`, run by `overlay-example.test.ts`. Its core:

```ts
const dailyCap: DebitRule = {
  name: "daily-cap",
  decide: ctx => (spentInLastDay(ctx.history) + ctx.requested > cap ? { refuse: "daily cap reached" } : undefined),
}
const debit = createDebit({ storage, clock }, { asset, rules: [dailyCap, perCallMax] })
await debit.debit({ accountId, key, amount: pricer.price(event).minor, shortfall: "refuse" })
```

The hooks the kit offers are only those two or more real products need: `priceBook` (a catalogue of model prices), `rules` on `debit`, `lotFilter` (which lots may pay), the `sink` and `alert` of `shadow`. Everything else is configuration.
