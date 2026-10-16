---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Add `agentproto app tunnel` — create a public (private-by-default, signed-link) tunnel for an app's `ui.port` through the running daemon, optionally minting the miniapp session deep link. Adds the daemon-side `app_tunnel` MCP tool plus the exported `buildSessionLink` helper and `AppTunnelResult` type.
