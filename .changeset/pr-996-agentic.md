---
"@agentproto/runtime": patch
---

Export new identity-stamping functions for daemon MCP gateway: `shouldInjectDaemonSelfMount` (determines which adapters receive default daemon gateway injection) and `stripOwnCallerStamp` (removes stale identity stamps when continuing sessions). Enable on-host claude-code spawns to receive identity-stamped daemon gateway by default, fixing the production issue where spawned sessions lacked parentSessionId lineage attribution.
