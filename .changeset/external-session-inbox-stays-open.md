---
"@agentproto/runtime": patch
---

An `external` session (Claude Desktop / `claude` CLI) whose liveness window lapsed now still accepts inbox delivery. Previously `sendMessage` raised `session_not_alive` for the expired row, `restartSession` cannot revive an external row, so sentinel and `session_follow` events were parked in the sentinel journal and the sentinel was orphaned instead of reaching the session inbox that `agentproto hook inbox` drains. A killed or retired external row is still refused.
