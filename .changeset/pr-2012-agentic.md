---
"@agentproto/runtime": minor
"@agentproto/skill-pack-agentproto": patch
---

AIP-42 hot role refresh: new `session_role_refresh` and `session_role_watch` MCP tools re-read a manifest-spawned session's `AGENT.md` and apply the parts that can change in place without a restart. A changed role (body/persona/boundaries/traits text) is steered into the live session as a notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart`. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced) companion that refreshes automatically on each AGENT.md edit — off by default and in-memory only. The `ap-lifecycle` skill doc documents both tools.
