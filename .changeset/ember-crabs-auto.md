---
"@agentproto/runtime": minor
---

Resolve every session route param (id, slug, or legacy name) through the shared
`resolveSessionRef`, accept a `slug` in the `PATCH /sessions/:id` rename body and
the `session_rename` MCP tool, and apply a requested `slug` at agent spawn.
