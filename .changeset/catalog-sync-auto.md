---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
"@agentproto/runtime": patch
---

Sync generated catalog data from the pinned provider sources.

catalog-sync and runtime are named because their `src/__tests__` assertions
had to follow the refreshed data (context-window entry count, gpt-5.6 tier
repricing), and the coverage check counts anything under `src/` as
publish-affecting.
