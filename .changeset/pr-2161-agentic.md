---
"@agentproto/runtime": patch
---

Carry the caller session identity of a daemon-spawned session on its `/mcp` mount in both the `?callerSessionId=` query and a new `x-agentproto-caller-session-id` header, so the identity survives a client that rebuilds the mount URL. Recognize the daemon's own `/mcp` endpoint by origin and path rather than exact string so ambient mounts (localhost vs 127.0.0.1, trailing slash, extra query) are identity-stamped, while foreign endpoints and the scoped `/mcp/orchestrator` sub-gateway remain untouched. Restart and continue-fresh strip the retired session's identity header along with its query stamp.
