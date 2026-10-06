---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

session-steward: the workflow now reads the un-paged `{sessions}` shape from `session_list` (a dry run over 545 sessions used to report "0 live, 0 terminal"), defaults its verdict-memory `appId` to the installed `@agentproto/session-steward` (resolved through `app_list`, so a missing app turns memory off with a report note instead of failing a step; `appId: ""` really disables it), and waits for `session_wrapup_plan` instead of accepting the `{jobId}` fallback.
