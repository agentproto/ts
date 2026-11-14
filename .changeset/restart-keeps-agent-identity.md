---
"@agentproto/runtime": patch
---

`session_restart` carries the AIP-42 manifest identity (`agentId`, `agentManifestPath`, `agentRoleHash`, `agentToolsHash`) onto the restarted session's meta, and stages it for the `/mcp` gateway while the restarted driver starts. A restarted app agent keeps its `requires.apps` grants, its `create_tool` binding and its `session_role_refresh` baseline instead of coming back as `{role, agentSlug}` only.
