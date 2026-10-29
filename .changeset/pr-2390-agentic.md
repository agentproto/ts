---
"@agentproto/runtime": patch
"@agentproto/session-presets": minor
---

runtime: log sandbox `agent_start` failures (with box id, adapter and elapsed ms) on both the boot and restart paths so cold-box timeouts are visible in `daemon.log` instead of looking like a vanished spawn.

session-presets: raise the `agent_start` request ceiling to `AGENT_START_TIMEOUT_MS` (15 min) so a cold box that installs an adapter and initialises its first session no longer hits `MCP error -32001: Request timed out`.
