---
"@agentproto/runtime": patch
---

A session continued fresh keeps its agent manifest identity (`agentId`, `agentManifestPath`, `agentRoleHash`, `agentToolsHash`) and has it staged, with its frozen AGENT.md opt-in and deny grants, before the driver lists the gateway's tools. A continued Claude Code session no longer loses its `requires.apps` granted tools and opt-in tools, and the staged opt-in is the one the source froze, not a re-read of AGENT.md.
