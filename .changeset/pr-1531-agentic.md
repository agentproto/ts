---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/runtime": patch
---

Sync generated catalog data from the pinned provider sources: refreshed pricing (moonshot kimi-k2.6, minimax M2.7, deepseek/openrouter rows), removed delisted models (zai-org GLM-4.5/4.6-FP8/5.1-FP8, several opencode-go routes, baseten provider rows), and updated catalog-sync snapshot fixtures. Also replaces retired-id test pins (opencode-go `minimax-m2.5`/`omen-alpha`) with structural bounds in the claude-code, claude-sdk, and runtime model suites.
