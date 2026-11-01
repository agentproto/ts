---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Stop eager-resuming keepAlive sessions idle past a 30-minute default cutoff. The new `daemon.bootResumeKeepAliveMaxIdleMinutes` key replaces `daemon.bootResumeKeepAliveMaxIdleHours` from #2413 and changes the default from 24 hours to 30 minutes; `0` still disables the cutoff. No release consumed the hours key between #2413 and this change, so there is no published-key break. Pinned and operator-labelled sessions remain exempt, and completed sessions drop `keepAlive`.
