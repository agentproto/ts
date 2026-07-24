---
"@agentproto/model-catalog": minor
"@agentproto/runtime": patch
---

Fix first-party models incorrectly marked ineligible on vendor routes due to router pricing-key collisions. Introduce `resolvePricingExact` to avoid substring-matching false positives (e.g., `google/gemini-2.5-flash-image` → `gemini-2.5-flash`). Restore vendor route for `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` on direct Anthropic auth.
