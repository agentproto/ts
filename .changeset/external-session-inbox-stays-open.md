---
"@agentproto/runtime": patch
---

An `external` session (Claude Desktop / `claude` CLI) whose liveness window lapsed now still accepts inbox delivery. Previously `sendMessage` raised `session_not_alive` for the expired row and `restartSession` cannot revive an external row, so sentinel events, `session_follow` digests and workflow notices were parked or dropped instead of reaching the session inbox that `agentproto hook inbox` drains. `session_follow` also no longer routes an expired external follower through the revive path. A killed or retired external row is still refused. The rule lives in one exported predicate, `isExternalInboxOpen`, shared by `sendMessage` and `session_follow`.
