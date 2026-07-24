---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/model-catalog": patch
"@agentproto/runtime": patch
---

Add built-in custom route for local llm-endpoint Anthropic-compatible proxy. The runtime now registers the llm-endpoint route at daemon boot, allowing curated model references (e.g., moonshot/kimi-k2.7-code@llm-endpoint) to transparently route through the local proxy. Configuration is derived from the gateway preset to ensure single source of truth.
