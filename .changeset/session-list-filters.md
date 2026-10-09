---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/tool": patch
"@agentproto/skill-pack-agentproto": patch
---

Narrow `session_list` server-side instead of reading hundreds of sessions. New optional filters, shared by the MCP tool, `GET /sessions` and `agentproto sessions [list]`: `q` (substring over id/name/label/title/cwd), `excludeNoise` (drops `review:*`/`wf:*` sessions and ended command / plain-terminal runs), `excludeLabelPrefix`, `excludeLabels`, `excludeKinds`, `rootOnly`, `parentSessionId`, `updatedSince` and `startedSince` (ISO or relative, e.g. `24h`). Rows now come back newest-activity first and the response carries `total` for the filtered set. `fields` is now honoured without `limit`, and `session_list` errors are returned as tool errors. Without any filter the response only gains `total`. `paginated` in `@agentproto/tool` gains an `includeTotal` option; the long-form help moves to `tool_help {name:"session_list"}`.
