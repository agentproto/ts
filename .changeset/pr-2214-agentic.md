---
"@agentproto/adapter-opencode": patch
---

Give confined opencode spawns a writable state home (`XDG_STATE_HOME` pointed at the per-session config dir) so the MCP client's state store can be created under an app boundary and the daemon MCP mount stays alive.
