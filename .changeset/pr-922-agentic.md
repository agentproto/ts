---
"@agentproto/mastra": patch
"@agentproto/adapter-mastra-agent": patch
---

Fix Anthropic API crashes on trailing reasoning blocks by wiring ProviderHistoryCompat input processor to strip reasoning-type content from assistant messages before sending to the model provider.
