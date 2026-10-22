---
"@agentproto/apps": patch
---

Page the session-steward `session_list` scan under the MCP result cap (50 rows per page) and fail loudly on a truncation hint instead of reading it as an empty result.
