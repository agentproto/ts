---
"@agentproto/runtime": minor
---

Add spawn-time money-safety guard that rejects gateway/router models on incompatible wallets. Exports three new functions: `serviceableModelRoutes()`, `checkModelWalletEligibility()`, and `modelWalletIneligibleMessage()`. Adds new `model_wallet_ineligible` error code to `SpawnAgentSessionResult`. The guard prevents silent 404s when a model bills to a different route than the resolved wallet can provide (e.g., DeepSeek on Anthropic's wallet when it requires OpenRouter).
