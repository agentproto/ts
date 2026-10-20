---
"@agentproto/runtime": minor
"@agentproto/app-client": patch
"agentproto-vscode": patch
---

**Output change (backwards-compatible shape, different default fields):** `adapter_list`'s COMPACT default projection no longer includes the `models` id array — it now emits `installed` (package presence: only status `supported` reports false; `available` and `unresolvable` still count as installed) and `modelCount` instead, because the model arrays pushed the whole listing past the daemon's 100 KB MCP result cap and produced a `{ truncated: true }` stub callers misread as an empty list. Consumers needing model ids must pass `full: true` (page it with `limit`/`cursor`). `AdapterListEntry` gains the optional `status` the merged listing already carries.

`@agentproto/app-client`'s runner picker walks `limit`/`cursor` pages of the compact rows (no `fields` filter — that bypasses the compact projection and would re-ship the unbounded model arrays), filters not-installed catalog rows out of the dropdown, and surfaces a truncated stub as an error instead of an empty list.

`agentproto-vscode`'s `DaemonClient.listAdapters()` page-walks full detail with `limit`/`cursor` (typed `McpInvalidParamsError` fallback for daemons predating the pagination params, `McpResultTruncatedError` instead of an empty list); `sessionConfig`, the harnesses tree, the Harnesses webview, the auth/model mind map, the auth explorer and the Configuration Lab surface a failed listing as an error instead of "no adapters installed".
