---
"@agentproto/runtime": patch
---

The context hard-stop floor now holds for a session with no context continuity policy, at admission and at the turn boundary, and the checkpoint, handoff, and continue-fresh paths work for such a session under the defaults instead of returning an error. After an auto-compaction, the session is re-evaluated immediately so a compaction that did not free enough is acted on without waiting for the next prompt.
