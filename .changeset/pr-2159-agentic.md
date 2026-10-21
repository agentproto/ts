---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Autocompact on an absolute token threshold (`contextContinuity.autoCompactAtTokens`), the resume prompt that follows it, and the lineage-aware `transcript_search` / `transcript_read` MCP tools for conversation resumption. The CLI gains `agentproto sessions restart --auto-compact-at-tokens <n>` and carries the existing continuity policy across a restart.
