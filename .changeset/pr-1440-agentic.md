---
"@agentproto/runtime": minor
---

New read-only `provider_key_list` MCP tool exposing the legacy `~/.agentproto/providers.json` provider key store as one-way identity rows (fingerprint/last4, `source`, `shadowedByEnv`) — never raw keys.
