---
"@agentproto/runtime": minor
---

`SessionAwaitingQuestion` gains an optional `kind` (`permission`, `context` or `harness`) set by every daemon writer of the awaiting question: a driver-reported permission request, the context-continuity ask, and a harness or heuristic question.
The `session_flag_status` override leaves it absent (unclassified); nothing reads it yet, so no client behaviour changes.
