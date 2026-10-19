---
"@agentproto/runtime": minor
---

Persist the orchestrator scope-token registry to `orchestrator-scopes.json` (mode 0600, atomic debounced writes) so `/mcp/orchestrator?scope=` URLs already baked into session descriptors keep authorizing across a daemon restart, prune dead-owner and orphaned unowned tokens at boot, and adopt legacy tokens minted by older daemons from the session descriptors that still reference them (never wider than the default tool subset). Adds new exported API: `orchestratorScopesFile()`, `adoptLegacyOrchestratorScopes()`, `collectReferencedOrchestratorScopeTokens()`, the `ScopeTokenRegistryOptions` type, and an optional `opts` parameter on `createScopeTokenRegistry()`.
