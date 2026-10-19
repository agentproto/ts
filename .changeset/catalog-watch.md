---
"@agentproto/model-intel": minor
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, and a `catalog_diff` MCP tool in `@agentproto/runtime` backed by a persisted snapshot store — plus a `model-catalog-watch` app (daily cron routine + workflow: sync → diff → gate → free-model digest).
