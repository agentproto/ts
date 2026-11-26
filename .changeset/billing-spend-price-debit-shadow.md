---
"@agentproto/billing": minor
---

Add `price`, `debit` and `shadow` to `@agentproto/billing/spend`. `createPricer` turns a metered event into minor units of the primary asset from a usage category (measured, fixed, catalog, resolver or flat cost), with one rate derived from the manifest anchor, `at-cost` that nothing overrides, a per-action floor, and an unpriced event that fails closed; `assertMarginFloors` fails a category that sells under its margin floor. `createDebit` spends directly on the journal's `burn` verb, idempotent by key, with `refuse` or `absorb` for a shortfall (a postpaid account is a lot with a negative floor). `createShadow` prices and records an event outside the journal and refuses to start without a pricer or a sink.
