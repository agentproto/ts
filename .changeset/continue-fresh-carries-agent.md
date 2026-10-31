---
"@agentproto/runtime": minor
---

`session_continue_fresh` now carries the source's role, agent name, frozen delegation list and memory opt-out to the successor, which used to restart on the default agent for its depth. An explicit `agent` or `role` in the request wins and nothing is carried.
