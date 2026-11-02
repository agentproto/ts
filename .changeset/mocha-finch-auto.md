---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add opt-in usage-limit turnRetry class that falls back instead of retrying. Behavior change beyond the new class: a turn that already made a side-effecting tool call no longer walks the AIP-46 fallback chain after an auth or usage-limit failure unless `retryAfterToolCalls` is set.
