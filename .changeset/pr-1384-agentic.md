---
"@agentproto/mcp-server": minor
"@agentproto/runtime": patch
---

feat(mcp-server): `toMcpTool` / `buildMcpTool` gain a `ui` option (definition-level `_meta.ui.resourceUri`) and opt-in `annotations` derived from the contract; call results carry `structuredContent`; new `registerUiResource` helper and `MCP_APP_MIME_TYPE` for MCP Apps `ui://` panels.

refactor(runtime): reuse `@agentproto/mcp-server`'s `registerUiResource` in the mcp-apps adapter instead of duplicating resource registration.
