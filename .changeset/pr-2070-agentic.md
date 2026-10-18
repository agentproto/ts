---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

fix(sandbox): sandboxed sessions survive a daemon restart and idle reap. The boot reattach pass adopts detached sandbox rows whose workspace bucket no other live daemon serves (they were otherwise stranded as unserved), a restarted sandbox row still awaiting its first prompt gets a 60 min reap grace, a busy mid-turn row is never reapable, an idle reap pauses the box instead of stopping it when the final checkpoint did not secure the work, and the CLI prefixes daemon.log lines with an ISO-8601 timestamp when output is redirected.
