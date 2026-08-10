---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

Fix MCP app bridge injection idempotency check that was incorrectly skipping injection for documents consuming `window.McpApp.connect()`. Change regex from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Add defensive guard in mail-triage UI to handle missing bridge gracefully.
