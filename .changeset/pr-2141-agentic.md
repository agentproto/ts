---
"@agentproto/runtime": minor
"@agentproto/app-client": patch
"agentproto-vscode": patch
---

Make `adapter_list`'s compact projection budget-safe: the default view now emits `installed` and `modelCount` instead of the full `models` array (which pushed the whole listing past the MCP 100 KB result cap and produced a `{ truncated: true }` stub callers misread as an empty list), and `AdapterListEntry` gains an optional `status`. The app-client runner picker and the VS Code daemon client now walk `limit`/`cursor` pages instead of issuing one unbounded call, and a truncated response is surfaced as an error rather than an empty adapter list; `sessionConfig` and the harnesses tree show that error instead of "no adapters".
