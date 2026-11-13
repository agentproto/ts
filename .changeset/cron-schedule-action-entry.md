---
"@agentproto/runtime": patch
---

The `cron.schedule` entry of the permission action table now says it is enforced as `tool.invoke` on `/mcp` by the tool deny gate (it read "/mcp auth only"), lists `cron_update`, and notes that the HTTP `/cron` write routes are not a `tool.invoke`: they require the sessions credential, not a session grant. Docs-only: no behaviour change.
