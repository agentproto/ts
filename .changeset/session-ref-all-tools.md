---
"@agentproto/runtime": patch
---

Every session-addressing tool accepts `sessionId` / `idOrName` / `slug`: the MCP session tools now route their lookups through the shared `resolveSessionRef` + `sessionRefSchema` instead of `findByIdOrName` alone, so historical/legacy-name and slug handles resolve uniformly across `session_detail`, `session_restart`, `session_stop`, and the rest of the session surface.
