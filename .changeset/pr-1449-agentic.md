---
"@agentproto/runtime": minor
---

Add the config surface: `config_get`/`config_set` MCP tools over the config key registry, a `config:changed` runtime event, and REST twins `GET /config` / `PATCH /config` on the runtime HTTP server. Registered on the root `/mcp` server only; secret values are always redacted.
