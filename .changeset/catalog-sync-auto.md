---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
---

Sync generated catalog data from the pinned provider sources.

catalog-sync's own `src/__tests__` assertions (context-window snapshot count)
had to follow the refreshed data, which is why catalog-sync is bumped
alongside model-catalog even though no generator logic changed in the
generators themselves.
