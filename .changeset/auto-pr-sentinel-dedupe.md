---
"@agentproto/sentinel": patch
"@agentproto/runtime": patch
---

Stop the PR auto-linker creating two identical sentinels for one PR: concurrent links for the same (PR, target session) are now guarded in flight, and `recordOpenedPr` dedupes on the PR url alone instead of (adapter, url).
