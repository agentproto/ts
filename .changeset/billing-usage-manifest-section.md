---
"@agentproto/billing": minor
---

Read the optional `usage` section of `BILLING.md` (categories as data: `match`, `cost` measured / catalog / fixed, `margin` or `at-cost`, `marginFloor`, `floorMinor`) into the manifest handle, through the zod schema and the vendored `BILLING.schema.json` (kept in step by the drift test). A category that writes its own rate is refused, as are duplicate ids, `at-cost` with a `marginFloor` above 1 and a fixed cost in a currency with no rate. The handle's `usage` feeds `createPricer`.
