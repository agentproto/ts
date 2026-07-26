---
"@agentproto/adapter-mastracode": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Declare MastraCode's model-derived api-key auth contract and enforce it in catalog/session eligibility.

- `@agentproto/adapter-mastracode`: adds `modelDerivedApiKey: true` so the runtime knows its direct-route API keys derive from the chosen model; the capability strategy now reports each provider's wire protocol (`apiMode`) and never claims subscription support.
- `@agentproto/driver-agent-cli`: accepts `modelDerivedApiKey` in the AIP-45 manifest schema.
- `@agentproto/runtime`: `buildCatalogModels` now includes api-key profiles for adapters that declare `modelDerivedApiKey`, matching `spawnEligibilityManifest`.
- `agentproto-vscode`: Configuration Lab surfaces the corrected MastraCode eligibility (api-key profiles only; no Anthropic subscription defaults).
