---
"@agentproto/cli": patch
---

`agentproto hook inbox` now reads the daemon session id from `--session`, else `$AGENTPROTO_SESSION_ID`.
It no longer falls back to `$CLAUDE_CODE_SESSION_ID` or the hook payload's `session_id`, which are the harness's own ids.
