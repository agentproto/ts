---
"@agentproto/runtime": patch
---
"@agentproto/tool": patch
---

`paginated` now applies an explicit `fields` allowlist to the full record on the paginated branch instead of the compact projection (unless `compact: true` is explicit), so requested fields outside the compact set are no longer silently dropped.
