---
"@agentproto/computer-api": patch
"@agentproto/sandbox": patch
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Reap ORPHAN computer boxes: `agentproto sandbox gc` (and the new `sandbox_gc` MCP tool) now sweep the provider's control plane for boxes it still holds and charges RAM for that the daemon's sandbox registry never knew and no live session references. The computer controller's `GET /v1/computers` list is the new surface (`@agentproto/sandbox-computer` gained `listBoxes`); the orphans are listed with their state, age and memory, and deleted with `?force=true` only under `--apply` (dry run by default). A box held by a live session is never a candidate, and a controller that errors is reported without stopping the sweep of the other providers.
