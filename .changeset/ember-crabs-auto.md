---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Resolve every session route param (id, slug, or legacy name) through the shared
`resolveSessionRef`, accept a `slug` in the `PATCH /sessions/:id` rename body and
the `session_rename` MCP tool, and add `sessions start --slug` / `sessions
terminal --slug` (with `--name` kept as its alias).
