---
"@agentproto/app": minor
"@agentproto/runtime": minor
---

Exposed imported tools keep their result, widget link and `ui://` view on the `/mcp` gateway. An `imported:` entry of `exposes.tools` now returns the import's `CallToolResult` unchanged (image blocks, `structuredContent`, `isError`, `_meta`), carries the imported tool's `_meta.ui` on `tools/list`, and passes only the input keys its `inputSchema` declares. The new APP.md key `exposes.resources` (distinct `ui://` URIs, validated by `parseExposedTools`) is the per-app allowlist the gateway relays on `resources/read`; any other URI is answered as unknown.
