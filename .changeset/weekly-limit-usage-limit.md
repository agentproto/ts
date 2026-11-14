---
"@agentproto/runtime": patch
---

A weekly subscription cap ("You've hit your weekly limit", "weekly usage limit reached", "weekly limit exceeded") is now recognised as a provider usage limit, so `classifyTurnError` returns `usage-limit` and a session ending on it gets the `provider-limit` reason. Opt-in `turnRetry` fallbacks on `usage-limit` now fire for it. Ordinary 429 rate limits are unchanged.
