---
"@agentproto/runtime": minor
"@agentproto/app-client": patch
---

**Output change (backwards-compatible shape, different default fields):** `adapter_list`'s COMPACT default projection no longer includes the `models` id array — it now emits `installed` (package presence: only status `supported` reports false) and `modelCount` instead, because the model arrays pushed the whole listing past the daemon's 100 KB MCP result cap and produced a `{ truncated: true }` stub callers misread as an empty list. Consumers needing model ids must pass `full: true` (page it with `limit`/`cursor`). `AdapterListEntry` gains the optional `status` the merged listing already carries.

`@agentproto/app-client`'s runner picker walks `limit`/`cursor` pages of the compact rows, filters not-installed catalog rows, and surfaces a truncated stub as an error instead of an empty list.
