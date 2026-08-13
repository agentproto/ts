---
"@agentproto/runtime": minor
---

Daemon-side FIFO prompt queue with force semantics: `enqueuePrompt` gains `queue`/`force` options, new `removeQueuedPrompt` method and `QueuedPrompt` type, and an HTTP `DELETE /queue/:id` endpoint. Messages arriving mid-turn are held in an ordered queue and dispatched sequentially as turns complete.
