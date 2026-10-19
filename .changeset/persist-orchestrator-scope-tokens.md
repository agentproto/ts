---
"@agentproto/runtime": patch
---

Persist the orchestrator scope-token registry to `orchestrator-scopes.json` (mode 0600, atomic debounced writes) so `/mcp/orchestrator?scope=` URLs already baked into session descriptors keep authorizing across a daemon restart, prune tokens whose owning session is gone or unrecoverable at boot, and adopt legacy tokens minted by older daemons from the session descriptors that still reference them (never wider than the default tool subset).
