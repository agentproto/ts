---
"@agentproto/runtime": minor
---

Imported MCPs can carry a source-side `allowTools` list (exact names or `*` patterns). The proxy registry enforces it on every path to the import (`/mcp/imported/<id>`, `mcp_imported_tool_list`, `mcp_imported_call`): other tools are hidden from `tools/list` and refused on `tools/call` before the upstream is contacted. `mcp_import` accepts `allowTools`; a re-import keeps the existing list unless a new one is given; a malformed list fails closed.
