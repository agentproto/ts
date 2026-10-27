---
"@agentproto/runtime": minor
---

Add the `session:archive` action so an event routine can archive the session of a completed event through the durable reaction runner. The handler skips missing, already-archived, alive, pinned and keepAlive sessions with an `outcomeRef`, and surfaces an archive failure as a retryable reaction failure.
