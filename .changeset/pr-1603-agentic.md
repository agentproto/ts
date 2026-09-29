---
"@agentproto/runtime": patch
"agentproto-vscode": minor
---

`@agentproto/runtime`: the session list projections (`GET /sessions` summary and the compact `session_list` item) now carry `lastError` (capped at 2000 chars), so list views can show why an errored session died.

`agentproto-vscode`: the sessions webview derives a short, readable failure cause from `lastError` (`failureCauseFor`), renders it error-styled with the full error as a row tooltip, and splits errored sessions into a dedicated "Failed" section — "Attention" now holds stalled sessions only.
