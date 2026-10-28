---
"@agentproto/runtime": patch
---

One owner for runtime-initiated context compaction: the percent-band compaction path is no longer attempted, an auto-compaction writes a single checkpoint that the resume prompt reads its goal from, and auto-compact holds the context lock until its compaction turn has ended so a prompt arriving meanwhile queues or retries instead of colliding with it. The turn-boundary continue-fresh takes the same lock, so the two never act on one session in the same turn boundary.
