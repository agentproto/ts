---
"@agentproto/tool": minor
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

`paginated()` gains `defaultBody` (shape the unpaged answer: a bare array, or fields beside the rows) and `pageExtra` (fields merged into every page), and passes a non-array handler output (a tool's own error result) through untouched. The four local `paginatedLegacyList` copies in the runtime (`app_list`, `app_list_applied`, `task_list`, `app_data_list`, `app_external_list`) now use it, so `fields` is honoured on the unpaged call too (`app_list { full: true, fields: ["appId"] }` no longer ships every full record). The `defaultLimit` first page now flags itself `partial: true`; `truncated: true` stays on it as a deprecated alias, so "first page of many" is no longer only spelled like the MCP result-cap marker. `paginated()` refuses a `maxLimit` above `PAGE_LIMIT_MAX` (200, the most the page schema accepts); `harness_models`/`adapter_models` declared an unreachable 500. `app_list` ships each app's latest 20 runs plus `runCount` (the registry never prunes runs, so the history grew every record without bound); `task_list` pages carry `boardId`. The Store shows "last N of runCount".
