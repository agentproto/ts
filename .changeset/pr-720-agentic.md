---
"@agentproto/model-catalog": minor
"@agentproto/runtime": patch
---

Fix model ID routing for Anthropic-native adapters: reduce direct-anthropic refs (e.g., `anthropic/claude-sonnet-4-5`) to bare product IDs that the native Anthropic wire expects, while preserving vendor/product for gateway-routed models and non-Anthropic adapters.
