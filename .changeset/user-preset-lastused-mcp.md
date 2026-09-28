---
"@agentproto/runtime": minor
---

Stamp `UserPreset.lastUsedAt` whenever a spawn resolves a `presetId` to it
(agent_start, `/sessions/agent`, `/sessions/chat`), add `user_preset_list` /
`user_preset_save` / `user_preset_delete` MCP tools mirroring the
`/user-presets` HTTP routes, and add an `includeRecent` view (MCP and
`GET /user-presets?includeRecent=1`) that surfaces recent distinct spawn
configs derived from session history as favorite candidates.
