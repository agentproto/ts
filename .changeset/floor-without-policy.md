---
"@agentproto/runtime": patch
---

The context hard-stop floor now holds for a session with no context continuity policy, at admission and at the turn boundary, and the checkpoint and handoff routes no longer answer 409 for such a session.
After an auto-compaction that did not free enough, the session is evaluated once more right away instead of at its next prompt.
