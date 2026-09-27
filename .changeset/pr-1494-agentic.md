---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": patch
---

`agent_prompt`/`agent_start` (MCP) now accept the same content-block prompt shape the HTTP `POST /sessions/:id/prompt` route already did (new shared `promptInputSchema`). Print-arm adapters (`@agentproto/driver-agent-cli`) fail loudly with a turn error on non-text blocks instead of silently dropping them. `transcript-writer` materializes inline-bytes blocks (pasted images) into a content-addressed attachment store, and a new `GET /sessions/:id/attachments/:filename` route reads one back (new `AttachmentEntry`/`mimeTypeForExtension`/`sessionAttachmentsDir` exports).
