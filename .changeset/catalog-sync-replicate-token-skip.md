---
"@agentproto/catalog-sync": patch
---

catalog-sync: skip the Replicate image source's live refresh when `REPLICATE_API_TOKEN` is absent. The source now declares the token as an `env:REPLICATE_API_TOKEN` header, routing it through the runner's existing missing-env gate so it reuses the committed snapshot (like the authed LLM sources) instead of fetching unauthenticated, hitting 401, and crashing the whole `catalog-sync generate --refresh`.
