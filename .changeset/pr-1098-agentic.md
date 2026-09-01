---
"@agentproto/runtime": patch
---

Fix: re-add router prefix for modelDerivedApiKey adapters billed through gateways. Resolves production bug where adapters like opencode receive models without the router prefix when using gateway routes, causing 404s at the ACP boundary. The fix ensures adapters that derive their API key from the wire model's leading segment (opencode, mastracode, jcode, pi, mastra-agent) receive the properly prefixed model ID.
