---
"@agentproto/runtime": patch
---

`agent_start` now defaults `notifyParentOnCrash` to true for an `executor` session that has a declared or attached parent, so a supervisor hears when a child dies silently. An explicit `false` still opts out, and sessions without a parent or in another role keep the old off default. The `[child-crashed]` notice now also names the session that died (label and id), says in plain words whether it was mid-turn or idle when it stopped, and that it can no longer be messaged.
