---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Rename the keepAlive boot-resume idle cutoff to `daemon.bootResumeKeepAliveMaxIdleMinutes` with a 30-minute default (0 disables). This replaces the `daemon.bootResumeKeepAliveMaxIdleHours` key shipped in #2413. No release consumed the hours key in between, so the rename does not break any published config. Only explicitly pinned sessions remain exempt, and completed sessions drop `keepAlive`.
