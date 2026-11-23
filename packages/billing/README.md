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
