---
"@agentproto/runtime": patch
---

The HTTP write routes `POST /auth/profiles`, `PATCH`/`DELETE /auth/profiles/:id` and `POST`/`DELETE /apps/:appId/apply` now require the same credential as the mutating `/sessions/*` routes: the per-boot bearer token or an allowlisted Origin. A foreign browser Origin without the bearer is refused with 403, and `POST`/`PATCH` must send `content-type: application/json` (415 otherwise), so a cross-origin `text/plain` request cannot create a profile or apply an app. `GET /auth/profiles` and `GET /scopes/:scopeId/apps` stay open like the other read routes. The `agentproto` CLI and the MCP tools do not use these routes.
