---
"@agentproto/quota": minor
"@agentproto/model-intel": minor
"@agentproto/runtime": patch
---

Move the AIP-67 quota API to the new `@agentproto/quota` package. `@agentproto/model-intel` keeps `diffCatalog` and re-exports the quota API as deprecated aliases; `@agentproto/runtime` imports quota symbols from `@agentproto/quota`.
