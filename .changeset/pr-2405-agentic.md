---
"@agentproto/runtime": minor
---

`session_continue_fresh` now hands the source's recorded agent binding to its successor: the spawn role, the manifest/bound agent slug, the frozen `delegatesTo` list and a memory opt-out. An explicit `agent`, `role`, `agentId` or `agentPath` in the continuation request still wins and nothing is carried.
