---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

Page the session-steward `session_list` scan under the MCP result cap (50 rows per page across 16 pages) and fail loudly on a truncation hint instead of reading it as an empty result. The runtime change is regression-test coverage only (bytes-capped `session_list` fixture plus pagination/workflow tests).
