---
"@agentproto/runtime": minor
---

Additive `limit`/`cursor` pagination for the `catalog_models` and `catalog_provider_models` MCP tools: passing either param returns the shared `{ items, nextCursor?, total }` envelope over the filtered route/model array (cursor offset = position in the filtered array); omitting both keeps the byte-identical whole-catalog response.
