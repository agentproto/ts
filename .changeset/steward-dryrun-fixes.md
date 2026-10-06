---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

session-steward: a 0-token session is only "never ran" (stuck) when it is not busy, not starting/provisioning, has no queued first prompt, and is both older and idler than `idleMinutes` (a just-started busy session used to be flagged), and the "terminal sessions missing an outcome" section now lists only sessions that ended within the new `relabelWindowHours` input (default 24), at most 20 newest first, with a per-label count and an "… and N more" line instead of hundreds of lines.
