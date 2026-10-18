---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

fix(sandbox): sandboxed sessions survive a daemon restart and idle reap. The boot reattach pass now adopts detached sandbox rows whose workspace bucket no other live daemon serves (they were stranded as unserved), a restarted sandbox row still awaiting its first prompt gets a 60 min reap grace, and an idle reap pauses the box instead of stopping it when the final checkpoint did not secure the work.
