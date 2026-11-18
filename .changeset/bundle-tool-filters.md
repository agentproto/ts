---
"@agentproto/runtime": minor
---

Capability bundles gain optional per-import `toolFilters` (`{allow?, deny?}` keyed by import id, validated against `mcpImports`, deny wins). `mountImports` bakes them into the `/mcp/imported/<id>` ref as `allowTools`/`denyTools`; `bundle_create`/`bundle_update` and `POST/PUT /bundles` accept them. The imported-MCP mount now accepts `*` patterns (`list_*`) in those lists.
