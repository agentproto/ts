---
"@agentproto/runtime": minor
---

Added `session_role_refresh` and `session_role_watch` MCP tools (AIP-42 hot role refresh): a manifest-spawned session's AGENT.md can now be re-read and applied to a live keepAlive session without a restart. A changed role (body/persona/boundaries/traits text) is pushed into the session as a steer notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart` to change. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced, never polling) companion that calls the refresh automatically on every AGENT.md edit — off by default. This generalizes the ad-hoc composed-prompt-hash mechanism apps like Pygmalion previously hand-rolled for their own personas.
