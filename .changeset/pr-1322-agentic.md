---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add a `lane` filter (`agents` | `auto`) to `listSummaries` and `GET /sessions/summaries`, and make the sessions webview lane-aware (server-side lane filtering, stale-lane response discard, and reload-after-lane-switch handling).
