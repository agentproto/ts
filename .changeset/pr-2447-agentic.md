---
"@agentproto/runtime": patch
---

Default the daemon `/mcp` self-mount for every on-host adapter (not just hermes/claude-code) when a spawn supplies no explicit `mcpServers`; on-host workflow agent steps likewise receive the gateway by default. The injected entry carries a per-session `callerSessionId` and keeps `agent_start` visible to `delegationReachFor`, preventing depth-0 sessions from being downgraded to executor. Sandbox spawns remain excluded except hermes.
