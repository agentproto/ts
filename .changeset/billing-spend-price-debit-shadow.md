---
"@agentproto/billing": minor
---

Add `price`, `debit` and `shadow` to `@agentproto/billing/spend`. `createPricer` turns a metered event into minor units of the primary asset from a usage category (measured, fixed, catalog, resolver or flat cost), with one rate derived from the manifest anchor and an unpriced event that fails closed (margins, floors, rounding and modes come from the host's configuration; the kit has no value of its own); `assertMarginFloors` fails a category that sells under its margin floor. `createDebit` spends directly on the journal's `burn` verb, idempotent by key, with a shortfall behaviour the caller names (`refuse` or `absorb`, no default) and an injectable draw order. `createShadow` prices and records an event outside the journal and refuses to start without a pricer or a sink.
