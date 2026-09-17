---
"@agentproto/catalog-sync": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-opencode": patch
---

Refresh ledger and provider snapshots from pinned sources (opencode-go/zen, openrouter sync). Relax exact roster pins in the claude-code curated-models, claude-sdk gateway-modes, and opencode endpoint-menu tests to membership/bounds checks so catalog-synced roster growth doesn't redden the weekly sync.
