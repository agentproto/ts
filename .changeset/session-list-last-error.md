---
"@agentproto/runtime": patch
---

The session list projections (`GET /sessions` summary and the compact `session_list` item) now carry `lastError` (capped at 2000 chars), so list views can show why an errored session died.
