---
"@agentproto/runtime": patch
---

Turn-retry tests no longer hard-code real catalog ids: `helpers/catalog-models.ts` derives `FREE_MODEL`/`OTHER_FREE_MODEL`/`THIRD_FREE_MODEL`, the same-route rotation pair and a non-rotation `PAID_MODEL` from the live opencode route table, so a weekly Catalog Sync adding or retiring an id can no longer take the suite with it.
