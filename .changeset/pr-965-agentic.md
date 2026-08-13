---
"@agentproto/llm-endpoint": patch
---

Fix credential shape detection for Anthropic OAuth Access Tokens (OATs). When resolving env-key credentials without a mapped auth profile, the resolver now classifies tokens by shape — Anthropic OATs (`sk-ant-oat*`) get method:"oauth-bearer" instead of the hardcoded "api-key" — so `buildUpstreamAuthHeaders` emits `Authorization: Bearer` instead of `x-api-key`. Anthropic hard-rejects OATs sent as x-api-key ("invalid x-api-key"), and the runtime's billing-auth resolver injects subscription OATs into ANTHROPIC_API_KEY for certain adapters (e.g. pi) with no authSubscription override.
