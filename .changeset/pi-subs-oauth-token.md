---
"@agentproto/runtime": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-pi": patch
---

Claude subscription on pi, and honest subscription eligibility everywhere else. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY` — where Anthropic's edge rejects it as an invalid key after the session is already live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its real bearer door — `ANTHROPIC_OAUTH_TOKEN` ("alternative to API key", pi 0.80.x), scoped `provider: "anthropic"` — so a Claude subscription profile now runs pi's anthropic models natively (and never lights up its openai/google/moonshot ones). Adapters with no bearer surface (opencode/mastracode/jcode) fail fast at spawn with an actionable message (use an api-key profile or a gateway route) instead of failing opaquely upstream, and the catalog no longer advertises subscription profiles as runnable on them.
