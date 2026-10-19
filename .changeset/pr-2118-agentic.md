---
"@agentproto/model-intel": minor
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, a persisted-baseline `catalog_diff` MCP tool to `@agentproto/runtime`, and ship the `model-catalog-watch` bundled app (daily cron routine + `watch` workflow: sync → diff → gate → free-model digest) in `@agentproto/apps`.
