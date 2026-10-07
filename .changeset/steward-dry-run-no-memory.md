---
"@agentproto/runtime": patch
---

Session steward: a dry run (`apply: false`) no longer appends verdict memory to the app's `app_state` ledger, so its verdicts cannot be served from cache to a later real pass; the report says the memory was read but not written.
