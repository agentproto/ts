---
"@agentproto/cli": minor
---

`hook inbox` now reads a per-chat inbox id: `cc:<session_id>` from the Claude hook payload, so every Desktop conversation drains its own inbox instead of the one shared via the global `AGENTPROTO_SESSION_ID`. Daemon-spawned sessions (`AGENTPROTO_SESSION_ID=sess_...`) are unchanged, and the old global env is only a legacy fallback when the payload has no session id.
