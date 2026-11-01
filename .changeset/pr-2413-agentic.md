---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Stop the eager resume-on-boot pass from reviving `keepAlive` sessions idle longer than `daemon.bootResumeKeepAliveMaxIdleHours` (default 24h, `0` disables), leaving them dead-but-lazy-resumable while still exempting pinned and operator-labelled rows. Sessions marked completed now have their `keepAlive` flag cleared, and the boot pass also skips rows whose outcome is already completed.
