---
"@agentproto/runtime": patch
---

`session_follow`: a follow on the follower's own child now always delivers `turn-end` (added with a warning when an explicit event list omits it), and a follow whose `selector.sessionIds` names a session that gets restarted / continued is re-pointed at the successor instead of keeping the dead id.
