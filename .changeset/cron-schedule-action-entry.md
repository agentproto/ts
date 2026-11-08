---
"@agentproto/runtime": patch
---

The `cron.schedule` entry of the permission action table now says it is enforced as `tool.invoke` on `/mcp` by the tool deny gate (it read "/mcp auth only"), lists `cron_update`, and notes that the HTTP `/cron` routes are not gated. Docs-only: no behaviour change.
