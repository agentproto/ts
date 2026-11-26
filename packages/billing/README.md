# @agentproto/billing

Reference implementation of [AIP-74](https://agentproto.sh/docs/aip-74), a
**draft**. Private until step 7 of the kits plan: it is not published.

```
BILLING.md  ->  parseBillingManifest  ->  defineBillingManifest  ->  handle (derived rates, edges)
rail event  ->  SettlementProvider.verifyWebhook  ->  handleRailFact  ->  AIP-49 journal
```

## What is here

| File | Role |
|---|---|
| `schema.ts` | The zod schema of the frontmatter, mirroring `BILLING.schema.json` (see below). |
| `define-billing-manifest.ts` | `defineBillingManifest`: shape check, cross-reference rules (21), normalisation (22), derived rates from `anchor` and `fx` (26), AIP-49 edges, arbitrage check over every declared edge (14). |
| `manifest/` | `parseBillingManifest` (BILLING.md) and `loadBillingManifest`. |
| `payment.ts` | The payment path: check, fact, effect, trace. One `StoragePort.commit`, idempotent by event id, `traceOf`, `listOwed`. |
| `reclaim.ts` | Refunds (rule 6, never the bonus) and disputes (freeze, release, reclaim). |
| `periods.ts` | Paid subscription periods, the include drops (monthly inside a yearly period), `past_due` and grace. |
| `grants.ts`, `payer.ts`, `transfers.ts` | Free credits with deterministic keys, who pays (`self`, `hierarchy/v1`), parent to child allocation. |
| `settlement.ts` | `SettlementProvider`: the AIP-49 `SettlementPort` plus `verifyWebhook`, optional `refund` and `syncCatalog`. No second settlement interface. |
| `registry.ts` | The provider registry, mounted with `makeProviderFamily()` of `@agentproto/provider-kit`. |
| `rails.ts` | Rail variable names, the start-up guard (rule 24), `test` / `live` mode. |
| `spend/` | The spend primitives: `createPricer` (`price`), `createDebit` (`debit`), `createShadow` (`shadow`), and the holds (`hold`, `settle`, `release`) from their own PR. Mechanisms only, with neutral defaults. |
| `testing/` | In-memory stores, `FakeSettlementProvider`, a reference manifest and the framework-free BILL-* cases. |

No payment provider lives here (Stripe, Autumn and Lemon Squeezy arrive as `@agentproto/billing-<slug>`, step 4a).

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

The shape of an overlay:

1. **Configuration, not code.** Put every value in one object: category margins and floors (`UsageConfig`), the rounding (`round`), the draw order (`order`), what a shortfall does (`shortfall`), caps, bonus percents. The kit has no value of its own for any of them (floor 0, margin 1, no default shortfall).
2. **Call the primitives, add your rule around them.** A rule is a function that runs before or after `price`, `hold`, `debit` or `shadow`: a cap reads the journal before it debits; a pack bonus mints its own lot; a refusal passes `shortfall: "refuse"`; a cost that comes from a grid is a `resolver` you register in `createPricer`.
3. **Keep every write keyed.** Give each write a deterministic key (`bonus:<pack>`, the action's key for a charge) so a replay writes once.
4. **Stay on the journal.** The balance is whatever the AIP-49 journal says. Prepaid or postpaid is the `floor` of the lots you mint, not a mode of a spend.
5. **Test the rule, not the kit.** Run it against `InMemoryStorage` and `ManualClock` from `@agentproto/billing/testing`.

A complete, tested example (a fictional daily cap, a pack bonus and a refuse-when-short charge) is in `src/__tests__/overlay-example.ts`, run by `overlay-example.test.ts`. Its core:

```ts
const pricer = createPricer({ manifest, usage })          // your categories and margins
const debit = createDebit({ storage, clock }, { asset })

async function charge(event: UsageEvent) {
  const price = pricer.price(event).minor                  // the kit: one rate, fail closed
  if ((await spentToday(event.accountId)) + price > policy.dailyCapMinor) return { ok: false, reason: "capped" } // your rule
  return debit.debit({ accountId: event.accountId, key: event.key, amount: price, shortfall: policy.onShortfall })  // the kit
}
```
