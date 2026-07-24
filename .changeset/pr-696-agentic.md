---
"@agentproto/model-catalog": patch
"@agentproto/provider-presets": patch
"@agentproto/runtime": patch
---

Add `stripRouteSuffix()` utility to strip catalog @route suffix before passing model IDs to upstream providers, and fix llm-endpoint keyEnv from LLM_ENDPOINT_API_KEY to LLM_ENDPOINT_ACCESS_TOKENS.
