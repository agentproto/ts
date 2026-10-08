---
"@agentproto/runtime": patch
---

Add an opt-in public events origin, `POST /mcp/events/<secret>`, that serves a dedicated events-only MCP surface
(`events/*` plus one probe tool) over the 2026-07-28 protocol. Disabled unless `AGENTPROTO_MCP_EVENTS_SECRET`
(32+ chars) is set; subscriptions are limited to `AGENTPROTO_MCP_EVENTS_REPOS`.
