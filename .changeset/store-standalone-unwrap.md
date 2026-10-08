---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

Fix the builtin App Store panel showing "No apps installed, and the app catalog is empty" when opened standalone at `/apps/@agentproto/store/ui`. The standalone `tool-call` route wraps a builtin tool's MCP result a second time, and the panel bridge's `callTool` peeled only one layer. It now unwraps nested envelopes recursively, honours `isError` at every layer, and returns non-JSON text as a string, which fixes every builtin panel opened standalone. The store lists builtin panels from the catalog's `category: "builtin"` rows (open by default, each with an Open button, never counted as Available or toward the empty state), and its status bar shows installed / available / builtin counts. `@agentproto/runtime` only gains a comment on the double-wrap; the wire shape is unchanged.
