---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

The `cc:<id>` external row now carries `externalEntrypoint` next to `externalHostSessionId` on `GET /sessions/cc:<id>`. The `agentproto hook inbox` touch reads `entrypoint` (e.g. `claude-desktop-3p` for Claude Desktop) from the Claude registration file `~/.claude/sessions/<pid>.json` as it already reads `hostSessionId`, and `POST /sessions/:id/touch` accepts an optional `entrypoint` (`[A-Za-z0-9._-]{1,64}`). Read-only metadata under the same trust as the touch; a session studio UI can use it to link a Desktop parent back to its app.
