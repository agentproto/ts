---
"@agentproto/runtime": patch
---

Scale the default autocompact threshold with the context window: unset `autoCompactAtTokens` is now `max(150000, warnAtPct% of the window)` (550000 on a 1M window) instead of a flat 150000, so a 1M-window session no longer compacts at 15%. An explicit value stays absolute.
