---
"@agentproto/runtime": minor
---

Restart ended-but-resumable agent-cli sessions in place on the same id. An inbound message (a human writing to the session) also revives a deliberately-ended session (operator-completed / steward-*) in place; the sentinel, as an automatic path, still never does.
