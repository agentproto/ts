---
"@agentproto/runtime": minor
---

Add `boardId` spawn-time board pinning: allow clients to pin spawned agent sessions to explicit task boards via optional `boardId` parameter on `agent_start` (MCP) and HTTP spawn endpoints. The spawned board pin (`meta.boardId`) takes precedence over lineage-derived board resolution, enabling cowork-style operators to fan out multiple depth-0 root sessions onto a shared board without shared lineage. Backward-compatible: all new fields are optional, existing spawns unaffected.
