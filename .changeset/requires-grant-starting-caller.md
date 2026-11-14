---
"@agentproto/runtime": patch
---

The /mcp gateway now applies a starting session's requires.apps grants, AGENT.md opt-in and deny grants while its driver starts. An ACP adapter such as claude-code lists the gateway's tools inside `session/new`, before the descriptor is registered, so an app agent saw only the read tools of the apps it requires (#2661).
