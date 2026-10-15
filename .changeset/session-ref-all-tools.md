---
"@agentproto/runtime": patch
---

Every session-addressing tool accepts `sessionId` / `idOrName` / `slug`. The MCP session surface (`session_capabilities`, `session_restart`, `session_unarchive`, `session_tree`, …) now routes lookups through the shared `resolveSessionRef` + `sessionRefSchema` instead of `findByIdOrName` alone, and the same three-key addressing is extended to `command_log_tail` / command tool-call reads, `conversation_read`, `conversation_export`, `workspace_brain_ingest`, and `app_session_events`. Resolution is archived-inclusive (via `archivedInclusiveRegistry`), so a legacy `name`/`slug` still resolves for an archived session — e.g. `session_unarchive` — and `ambiguous`/`conflict` outcomes surface as errors rather than silently degrading to the raw query.
